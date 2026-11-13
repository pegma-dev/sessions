import { TableClient } from "@azure/data-tables";
import { fixedClock, type Logger, type PrincipalId } from "@pegma/spine";
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from "@pegma/storage-core";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { describe, expect, it } from "vitest";

import { TABLE_PORT } from "../../../test/azurite.js";
import {
  createSessionStore,
  type NewSession,
  type SessionRecord,
} from "./index.js";

const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `TableEndpoint=http://127.0.0.1:${TABLE_PORT}/${ACCOUNT};`,
].join(";");

let tableCounter = 0;

function freshAzureStore(requests?: string[]): Store {
  tableCounter += 1;
  const table = `sessions${tableCounter}t${process.pid}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
    additionalPolicies: [
      {
        position: "perRetry",
        policy: {
          name: "record-session-test-requests",
          sendRequest(request, next) {
            requests?.push(`${request.method} ${request.url}`);
            return next(request);
          },
        },
      },
    ],
  });
  return createAzureTablesStore({ client });
}

const backends = [
  { name: "memory", freshStore: createMemoryStore },
  { name: "Azurite", freshStore: freshAzureStore },
] as const;

interface StoredSessionFixture extends SessionRecord {
  readonly kind: "session";
  readonly idHash: string;
}

interface StoredRevocationFixture {
  readonly kind: "principalRevocation";
  readonly principalHash: string;
  readonly principalId: PrincipalId;
  readonly revoking: boolean;
  readonly activeRevocations: number;
  readonly revocationToken: string;
  readonly leaseExpiresAt: string;
  readonly revocationGeneration: number;
  readonly revokedThrough: string;
  readonly updatedAt: string;
}

type StoredFixture = StoredSessionFixture | StoredRevocationFixture;

function storedSessions(
  records: readonly StoredFixture[],
): StoredSessionFixture[] {
  return records.filter(
    (record): record is StoredSessionFixture => record.kind === "session",
  );
}

function storedRevocations(
  records: readonly StoredFixture[],
): StoredRevocationFixture[] {
  return records.filter(
    (record): record is StoredRevocationFixture =>
      record.kind === "principalRevocation",
  );
}

function inspectStorage(base: Store): {
  readonly store: Store;
  records(): CollectionStore<StoredFixture>;
  definition(): CollectionDefinition<StoredFixture>;
} {
  let captured: CollectionDefinition<StoredFixture> | undefined;
  return {
    store: {
      collection<T>(definition: CollectionDefinition<T>) {
        if (definition.name === "sessions") {
          captured =
            definition as unknown as CollectionDefinition<StoredFixture>;
        }
        return base.collection(definition);
      },
    },
    records() {
      if (captured === undefined) {
        throw new Error("The sessions collection was not requested.");
      }
      return base.collection(captured);
    },
    definition() {
      if (captured === undefined) {
        throw new Error("The sessions collection was not requested.");
      }
      return captured;
    },
  };
}

function wrapSessionCollection(
  base: Store,
  wrap: (
    collection: CollectionStore<StoredFixture>,
  ) => CollectionStore<StoredFixture>,
): Store {
  return {
    collection<T>(definition: CollectionDefinition<T>) {
      const collection = base.collection(definition);
      if (definition.name !== "sessions") {
        return collection;
      }
      return wrap(
        collection as unknown as CollectionStore<StoredFixture>,
      ) as unknown as CollectionStore<T>;
    },
  };
}

function pauseSessionRead(base: Store, phase: "before" | "after" = "before") {
  let next: "getVersioned" | "listVersioned" | undefined;
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function before(method: "getVersioned" | "listVersioned") {
    if (next !== method) return;
    next = undefined;
    reached();
    await resume;
  }
  const store = wrapSessionCollection(base, (collection) => {
    const getVersioned: typeof collection.getVersioned = async (...args) => {
      if (phase === "before") await before("getVersioned");
      const result = await collection.getVersioned(...args);
      if (phase === "after") await before("getVersioned");
      return result;
    };
    const listVersioned: typeof collection.listVersioned = async (...args) => {
      await before("listVersioned");
      return collection.listVersioned(...args);
    };
    return new Proxy(collection, {
      get(target, property) {
        if (property === "getVersioned") return getVersioned;
        if (property === "listVersioned") return listVersioned;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  return {
    store,
    entered,
    release,
    arm(method: typeof next) {
      next = method;
    },
  };
}

function recordingLogger() {
  const entries: {
    readonly level: string;
    readonly message: string;
    readonly fields?: Readonly<Record<string, unknown>>;
  }[] = [];
  const logger: Logger = {
    log(level, message, fields) {
      entries.push({
        level,
        message,
        ...(fields === undefined ? {} : { fields }),
      });
    },
  };
  return { logger, entries };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const NOW = "2026-07-27T12:00:00.000Z";
const PRINCIPAL = "prn_one" as PrincipalId;
const OTHER_PRINCIPAL = "prn_two" as PrincipalId;
const NEW_SESSION: NewSession = {
  principalId: PRINCIPAL,
  data: JSON.stringify({ displayName: "Ada" }),
};

for (const backend of backends) {
  describe(`session behavior over ${backend.name}`, () => {
    it("computes lifecycle fields and stores only a SHA-256 key", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const sessions = createSessionStore(inspected.store, {
        clock: fixedClock(NOW),
      });
      const rawId = "raw-session-secret";

      const created = await sessions.create(rawId, NEW_SESSION);
      const stored = await inspected.records().list("session");
      const [storedSession] = storedSessions(stored);

      expect(created).toEqual({
        ...NEW_SESSION,
        createdAt: NOW,
        expiresAt: "2026-08-03T12:00:00.000Z",
        lastSeenAt: NOW,
      });
      expect(storedSessions(stored)).toHaveLength(1);
      expect(storedSession?.idHash).toBe(await sha256(rawId));
      expect(storedSession?.idHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(rawId);
      expect(inspected.definition().name).toBe("sessions");
      expect(
        inspected.definition().key(storedSession as StoredFixture),
      ).toEqual({
        partition: "session",
        id: `session:${await sha256(rawId)}`,
      });
    });

    it("accepts positive finite lifetime configuration", async () => {
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
        absoluteLifetimeMs: 2_000,
        idleTimeoutMs: 1_000,
      });

      const created = await sessions.create("configured", NEW_SESSION);

      expect(created.expiresAt).toBe("2026-07-27T12:00:02.000Z");
      expect(
        await sessions.get("configured", "2026-07-27T12:00:00.999Z"),
      ).not.toBeNull();
    });

    it("rejects non-positive and non-finite durations", () => {
      for (const absoluteLifetimeMs of [
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(() =>
          createSessionStore(backend.freshStore(), {
            absoluteLifetimeMs,
          }),
        ).toThrow(/positive finite/);
      }
      expect(() =>
        createSessionStore(backend.freshStore(), { idleTimeoutMs: 0 }),
      ).toThrow(/positive finite/);
    });

    it("observes the default clock after an overlapping read has touched the live session", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const paused = pauseSessionRead(inspected.store);
      let milliseconds = Date.parse(NOW);
      const clock = { now: () => new Date(milliseconds).toISOString() };
      const sessions = createSessionStore(paused.store, { clock });
      await sessions.create("overlapping-default-read", NEW_SESSION);

      paused.arm("getVersioned");
      const earlier = sessions.get("overlapping-default-read");
      await paused.entered;
      milliseconds += 1;
      try {
        // This actual SDK read, not a forged storage row, advances lastSeenAt.
        expect(await sessions.get("overlapping-default-read")).not.toBeNull();
      } finally {
        paused.release();
      }

      expect((await earlier)?.lastSeenAt).toBe(clock.now());
      expect(await sessions.get("overlapping-default-read")).not.toBeNull();
      expect(
        storedSessions(await inspected.records().list("session")),
      ).toHaveLength(1);
    });

    it("observes the default sweep clock after an overlapping read has touched the live session", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const paused = pauseSessionRead(inspected.store);
      let milliseconds = Date.parse(NOW);
      const clock = { now: () => new Date(milliseconds).toISOString() };
      const sessions = createSessionStore(paused.store, { clock });
      await sessions.create("overlapping-default-sweep", NEW_SESSION);

      paused.arm("listVersioned");
      const sweeping = sessions.purgeExpired();
      await paused.entered;
      milliseconds += 1;
      try {
        expect(await sessions.get("overlapping-default-sweep")).not.toBeNull();
      } finally {
        paused.release();
      }

      expect(await sweeping).toBe(0);
      expect(await sessions.get("overlapping-default-sweep")).not.toBeNull();
      expect(
        storedSessions(await inspected.records().list("session")),
      ).toHaveLength(1);
    });

    it("observes expiry at the default clock after the awaited session read", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const paused = pauseSessionRead(inspected.store);
      let milliseconds = Date.parse(NOW);
      const clock = { now: () => new Date(milliseconds).toISOString() };
      const sessions = createSessionStore(paused.store, {
        clock,
        absoluteLifetimeMs: 1_000,
      });
      await sessions.create("delayed-default-expiry", NEW_SESSION);

      paused.arm("getVersioned");
      const reading = sessions.get("delayed-default-expiry");
      await paused.entered;
      try {
        milliseconds += 1_000;
      } finally {
        paused.release();
      }

      expect(await reading).toBeNull();
      expect(
        storedSessions(await inspected.records().list("session")),
      ).toHaveLength(0);
    });

    it("observes expiry at the default clock after the awaited sweep list", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const paused = pauseSessionRead(inspected.store);
      let milliseconds = Date.parse(NOW);
      const clock = { now: () => new Date(milliseconds).toISOString() };
      const sessions = createSessionStore(paused.store, {
        clock,
        absoluteLifetimeMs: 1_000,
      });
      await sessions.create("delayed-sweep-expiry", NEW_SESSION);

      paused.arm("listVersioned");
      const sweeping = sessions.purgeExpired();
      await paused.entered;
      try {
        milliseconds += 1_000;
      } finally {
        paused.release();
      }

      expect(await sweeping).toBe(1);
      expect(
        storedSessions(await inspected.records().list("session")),
      ).toHaveLength(0);
    });

    it("observes one default clock after a missing read and an empty sweep", async () => {
      const paused = pauseSessionRead(backend.freshStore());
      let observations = 0;
      const sessions = createSessionStore(paused.store, {
        clock: {
          now() {
            ++observations;
            return NOW;
          },
        },
      });
      paused.arm("getVersioned");
      const missing = sessions.get("unknown-session");
      await paused.entered;
      try {
        expect(observations).toBe(0);
      } finally {
        paused.release();
      }

      expect(await missing).toBeNull();
      expect(observations).toBe(1);
      expect(await sessions.purgeExpired()).toBe(0);
      expect(observations).toBe(2);
      expect(await sessions.get("unknown-session", NOW)).toBeNull();
      expect(await sessions.purgeExpired(NOW)).toBe(0);
      expect(observations).toBe(2);
    });

    it("preserves explicit read and sweep instants after awaited storage", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const paused = pauseSessionRead(inspected.store);
      let milliseconds = Date.parse(NOW);
      const clock = { now: () => new Date(milliseconds).toISOString() };
      const sessions = createSessionStore(paused.store, {
        clock,
        absoluteLifetimeMs: 1_000,
      });
      await sessions.create("explicit-read-instant", NEW_SESSION);
      const explicitNow = "2026-07-27T12:00:00.500Z";

      paused.arm("getVersioned");
      const reading = sessions.get("explicit-read-instant", explicitNow);
      await paused.entered;
      try {
        milliseconds += 1_000;
      } finally {
        paused.release();
      }

      expect(await reading).not.toBeNull();
      expect(await sessions.purgeExpired(explicitNow)).toBe(0);
      expect(
        storedSessions(await inspected.records().list("session")),
      ).toHaveLength(1);
      expect(await sessions.get("explicit-read-instant")).toBeNull();
    });

    it("returns the initially validated record without claiming its touch", async () => {
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
      });
      await sessions.create("touch-return", NEW_SESSION);
      const touchedAt = "2026-07-27T13:00:00.000Z";

      const first = await sessions.get("touch-return", touchedAt);
      const second = await sessions.get("touch-return", touchedAt);

      expect(first?.lastSeenAt).toBe(NOW);
      expect(second?.lastSeenAt).toBe(touchedAt);
    });

    describe("read-only observation", () => {
      it("uses one fresh hashed-key read without any mutation for live, dead, or missing sessions", async () => {
        const inspected = inspectStorage(backend.freshStore());
        let readOnly = false;
        const calls: unknown[] = [];
        const wrapped = wrapSessionCollection(
          inspected.store,
          (collection) =>
            new Proxy(collection, {
              get(target, property) {
                const value: unknown = Reflect.get(target, property, target);
                if (typeof value !== "function") return value;
                if (!readOnly) return value.bind(target);
                if (property !== "getVersioned") {
                  throw new Error(
                    `Unexpected observation operation: ${String(property)}`,
                  );
                }
                return (...args: unknown[]) => {
                  calls.push(args);
                  return Reflect.apply(value, target, args);
                };
              },
            }),
        );
        const { logger, entries } = recordingLogger();
        const sessions = createSessionStore(wrapped, {
          clock: fixedClock(NOW),
          logger,
          idleTimeoutMs: 1_000,
        });
        const rawId = "observe-raw-session-secret";
        const created = await sessions.create(rawId, NEW_SESSION);
        const key = {
          partition: "session",
          id: `session:${await sha256(rawId)}`,
        };
        const before = await inspected.records().getVersioned(key);

        readOnly = true;
        expect(await sessions.observe(rawId, NOW)).toEqual(created);
        expect(
          await sessions.observe(rawId, "2026-07-27T12:00:01.000Z"),
        ).toBeNull();
        expect(await sessions.observe("observe-missing", NOW)).toBeNull();
        await expect(sessions.observe("")).rejects.toThrow(
          "Session id must be a non-empty string.",
        );
        readOnly = false;

        expect(calls).toEqual([
          [key],
          [key],
          [
            {
              partition: "session",
              id: `session:${await sha256("observe-missing")}`,
            },
          ],
        ]);
        expect(await inspected.records().getVersioned(key)).toEqual(before);
        expect(JSON.stringify(calls)).not.toContain(rawId);
        expect(entries).toEqual([]);
      });

      it("does not prolong idle expiry while get still advances the anchor", async () => {
        const sessions = createSessionStore(backend.freshStore(), {
          clock: fixedClock(NOW),
          idleTimeoutMs: 500,
          absoluteLifetimeMs: 2_000,
        });
        await sessions.create("observe-idle", NEW_SESSION);
        await sessions.create("get-idle", NEW_SESSION);
        const later = "2026-07-27T12:00:00.499Z";

        expect(
          (await sessions.observe("observe-idle", later))?.lastSeenAt,
        ).toBe(NOW);
        expect(await sessions.get("get-idle", later)).not.toBeNull();
        expect(
          await sessions.observe("observe-idle", "2026-07-27T12:00:00.500Z"),
        ).toBeNull();
        expect(
          (await sessions.observe("get-idle", "2026-07-27T12:00:00.998Z"))
            ?.lastSeenAt,
        ).toBe(later);
        expect(
          await sessions.observe("get-idle", "2026-07-27T12:00:00.999Z"),
        ).toBeNull();
      });

      it("rejects the absolute boundary even after activity advances idle expiry", async () => {
        const sessions = createSessionStore(backend.freshStore(), {
          clock: fixedClock(NOW),
          absoluteLifetimeMs: 1_000,
          idleTimeoutMs: 2_000,
        });
        await sessions.create("observe-absolute", NEW_SESSION);
        await sessions.get("observe-absolute", "2026-07-27T12:00:00.999Z");
        expect(
          await sessions.observe(
            "observe-absolute",
            "2026-07-27T12:00:00.999Z",
          ),
        ).not.toBeNull();
        expect(
          await sessions.observe(
            "observe-absolute",
            "2026-07-27T12:00:01.000Z",
          ),
        ).toBeNull();
      });

      it("observes the default clock after a concurrent get touches the session", async () => {
        const paused = pauseSessionRead(backend.freshStore());
        let milliseconds = Date.parse(NOW);
        const clock = { now: () => new Date(milliseconds).toISOString() };
        const sessions = createSessionStore(paused.store, { clock });
        await sessions.create("observe-touch-race", NEW_SESSION);
        paused.arm("getVersioned");
        const observing = sessions.observe("observe-touch-race");
        await paused.entered;
        try {
          milliseconds += 1;
          expect(await sessions.get("observe-touch-race")).not.toBeNull();
        } finally {
          paused.release();
        }
        expect((await observing)?.lastSeenAt).toBe(clock.now());
      });

      it.each(["absolute", "idle"] as const)(
        "checks %s expiry after the awaited snapshot without deleting it",
        async (boundary) => {
          const inspected = inspectStorage(backend.freshStore());
          const paused = pauseSessionRead(inspected.store, "after");
          let milliseconds = Date.parse(NOW);
          const sessions = createSessionStore(paused.store, {
            clock: { now: () => new Date(milliseconds).toISOString() },
            absoluteLifetimeMs: boundary === "absolute" ? 1_000 : 2_000,
            idleTimeoutMs: boundary === "idle" ? 1_000 : 2_000,
          });
          await sessions.create("observe-awaited-expiry", NEW_SESSION);
          paused.arm("getVersioned");
          const observing = sessions.observe("observe-awaited-expiry");
          await paused.entered;
          try {
            milliseconds += 1_000;
          } finally {
            paused.release();
          }
          expect(await observing).toBeNull();
          expect(
            storedSessions(await inspected.records().list("session")),
          ).toHaveLength(1);
        },
      );

      it("preserves explicit instants and never consults the clock for them", async () => {
        const paused = pauseSessionRead(backend.freshStore(), "after");
        let observations = 0;
        let milliseconds = Date.parse(NOW);
        const sessions = createSessionStore(paused.store, {
          clock: {
            now() {
              observations += 1;
              return new Date(milliseconds).toISOString();
            },
          },
          absoluteLifetimeMs: 1_000,
        });
        await sessions.create("observe-explicit", NEW_SESSION);
        observations = 0;
        paused.arm("getVersioned");
        const observing = sessions.observe(
          "observe-explicit",
          "2026-07-27T12:00:00.999Z",
        );
        await paused.entered;
        try {
          milliseconds += 1_000;
          expect(observations).toBe(0);
        } finally {
          paused.release();
        }
        expect(await observing).not.toBeNull();
        expect(
          await sessions.observe(
            "observe-explicit",
            "2026-07-27T12:00:01.000Z",
          ),
        ).toBeNull();
        expect(observations).toBe(0);
      });

      it("consults the default clock once after a missing read", async () => {
        const paused = pauseSessionRead(backend.freshStore());
        let observations = 0;
        const sessions = createSessionStore(paused.store, {
          clock: {
            now() {
              observations += 1;
              return NOW;
            },
          },
        });
        paused.arm("getVersioned");
        const observing = sessions.observe("observe-unknown");
        await paused.entered;
        try {
          expect(observations).toBe(0);
        } finally {
          paused.release();
        }
        expect(await observing).toBeNull();
        expect(observations).toBe(1);
        expect(await sessions.observe("observe-unknown", NOW)).toBeNull();
        expect(observations).toBe(1);
      });

      it.each([
        ["createdAt", "not-a-time"],
        ["expiresAt", "Infinity"],
        ["lastSeenAt", "NaN"],
        ["expiresAt", "2026-07-32T12:00:00.000Z"],
        ["createdAt", "2026-07-27T12:00:00.001Z"],
        ["lastSeenAt", "2026-07-27T12:00:00.001Z"],
      ] as const)(
        "fails closed without deleting malformed %s %s",
        async (field, value) => {
          const inspected = inspectStorage(backend.freshStore());
          const sessions = createSessionStore(inspected.store, {
            clock: fixedClock(NOW),
          });
          await sessions.create("observe-malformed", NEW_SESSION);
          const records = inspected.records();
          const [record] = storedSessions(await records.list("session"));
          await records.put({
            ...(record as StoredSessionFixture),
            [field]: value,
          });
          expect(await sessions.observe("observe-malformed", NOW)).toBeNull();
          expect(storedSessions(await records.list("session"))).toHaveLength(1);
        },
      );

      it("fails closed for invalid explicit times and an invalid default clock", async () => {
        const base = backend.freshStore();
        const sessions = createSessionStore(base, { clock: fixedClock(NOW) });
        await sessions.create("observe-invalid-now", NEW_SESSION);
        for (const now of [null, "not-a-time", "2026-07-27T11:59:59.999Z"]) {
          expect(
            await Reflect.apply(sessions.observe, sessions, [
              "observe-invalid-now",
              now,
            ]),
          ).toBeNull();
        }
        const badClock = createSessionStore(base, {
          clock: { now: () => "NaN" },
        });
        expect(await badClock.observe("observe-invalid-now")).toBeNull();
        expect(
          await sessions.observe("observe-invalid-now", NOW),
        ).not.toBeNull();
      });

      it.each(["individual", "principal"] as const)(
        "freshly refuses %s revocation during an awaited read",
        async (mode) => {
          const paused = pauseSessionRead(backend.freshStore());
          const sessions = createSessionStore(paused.store, {
            clock: fixedClock(NOW),
          });
          await sessions.create("observe-revoke-race", NEW_SESSION);
          expect(await sessions.observe("observe-revoke-race")).not.toBeNull();
          paused.arm("getVersioned");
          const observing = sessions.observe("observe-revoke-race");
          await paused.entered;
          try {
            if (mode === "individual")
              await sessions.destroy("observe-revoke-race");
            else
              expect(await sessions.destroyAllForPrincipal(PRINCIPAL)).toBe(1);
          } finally {
            paused.release();
          }
          expect(await observing).toBeNull();
          expect(await sessions.observe("observe-revoke-race")).toBeNull();
        },
      );

      it("does not claim to lock a snapshot against later revocation or resurrect it", async () => {
        const paused = pauseSessionRead(backend.freshStore(), "after");
        const sessions = createSessionStore(paused.store, {
          clock: fixedClock(NOW),
        });
        const created = await sessions.create(
          "observe-snapshot-race",
          NEW_SESSION,
        );
        paused.arm("getVersioned");
        const observing = sessions.observe("observe-snapshot-race");
        await paused.entered;
        try {
          await sessions.destroy("observe-snapshot-race");
        } finally {
          paused.release();
        }
        expect(await observing).toEqual(created);
        expect(await sessions.observe("observe-snapshot-race")).toBeNull();
      });

      it("propagates a fresh backend read failure instead of returning an earlier live result", async () => {
        let unavailable = false;
        const failure = new Error("observation backend unavailable");
        const wrapped = wrapSessionCollection(
          backend.freshStore(),
          (collection) => ({
            ...collection,
            async getVersioned(key) {
              if (unavailable) throw failure;
              return collection.getVersioned(key);
            },
          }),
        );
        const sessions = createSessionStore(wrapped, {
          clock: fixedClock(NOW),
        });
        await sessions.create("observe-read-error", NEW_SESSION);
        expect(await sessions.observe("observe-read-error")).not.toBeNull();
        unavailable = true;
        await expect(sessions.observe("observe-read-error")).rejects.toBe(
          failure,
        );
      });
    });

    it("refuses a collision and preserves the first record", async () => {
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
      });
      await sessions.create("same-id", NEW_SESSION);

      await expect(
        sessions.create("same-id", {
          principalId: OTHER_PRINCIPAL,
          data: "replacement",
        }),
      ).rejects.toThrow(/^Session id collision\.$/);

      expect(await sessions.get("same-id", NOW)).toMatchObject(NEW_SESSION);
    });

    it("treats unknown destruction as success", async () => {
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
      });

      expect(await sessions.get("unknown", NOW)).toBeNull();
      await expect(sessions.destroy("unknown")).resolves.toBeUndefined();
      await sessions.create("known", NEW_SESSION);
      await sessions.destroy("known");
      await expect(sessions.destroy("known")).resolves.toBeUndefined();
      expect(await sessions.get("known", NOW)).toBeNull();
    });

    it("is dead at both exact expiry boundaries", async () => {
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
        absoluteLifetimeMs: 1_000,
        idleTimeoutMs: 500,
      });
      await sessions.create("absolute-boundary", NEW_SESSION);
      await sessions.create("idle-boundary", NEW_SESSION);

      expect(
        await sessions.get("absolute-boundary", "2026-07-27T12:00:01.000Z"),
      ).toBeNull();
      expect(
        await sessions.get("idle-boundary", "2026-07-27T12:00:00.500Z"),
      ).toBeNull();
    });

    it("fails closed on invalid now, creation, expiry, and idle timestamps", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const sessions = createSessionStore(inspected.store, {
        clock: fixedClock(NOW),
      });
      await sessions.create("invalid-now", NEW_SESSION);
      await sessions.create("invalid-created", NEW_SESSION);
      await sessions.create("invalid-expiry", NEW_SESSION);
      await sessions.create("invalid-idle", NEW_SESSION);
      await sessions.create("normalized-expiry", NEW_SESSION);

      expect(await sessions.get("invalid-now", "not-a-time")).toBeNull();

      const records = inspected.records();
      const stored = storedSessions(await records.list("session"));
      const createdKey = await sha256("invalid-created");
      const expiryKey = await sha256("invalid-expiry");
      const idleKey = await sha256("invalid-idle");
      const normalizedKey = await sha256("normalized-expiry");
      const createdRecord = stored.find(
        (value) => value.idHash === createdKey,
      ) as StoredSessionFixture;
      const expiryRecord = stored.find(
        (value) => value.idHash === expiryKey,
      ) as StoredSessionFixture;
      const idleRecord = stored.find(
        (value) => value.idHash === idleKey,
      ) as StoredSessionFixture;
      const normalizedRecord = stored.find(
        (value) => value.idHash === normalizedKey,
      ) as StoredSessionFixture;
      await records.put({ ...createdRecord, createdAt: "not-a-time" });
      await records.put({ ...expiryRecord, expiresAt: "Infinity" });
      await records.put({ ...idleRecord, lastSeenAt: "NaN" });
      await records.put({
        ...normalizedRecord,
        expiresAt: "2026-07-32T12:00:00.000Z",
      });

      expect(await sessions.get("invalid-created", NOW)).toBeNull();
      expect(await sessions.get("invalid-expiry", NOW)).toBeNull();
      expect(await sessions.get("invalid-idle", NOW)).toBeNull();
      expect(await sessions.get("normalized-expiry", NOW)).toBeNull();

      await sessions.create("invalid-purge-now", NEW_SESSION);
      expect(await sessions.purgeExpired("still-not-a-time")).toBe(1);

      // JavaScript callers can supply malformed values despite the TS type.
      // Only undefined selects the default clock; null must still fail closed.
      await sessions.create("invalid-null-read", NEW_SESSION);
      expect(
        await Reflect.apply(sessions.get, sessions, [
          "invalid-null-read",
          null,
        ]),
      ).toBeNull();
      await sessions.create("invalid-null-purge", NEW_SESSION);
      expect(await Reflect.apply(sessions.purgeExpired, sessions, [null])).toBe(
        1,
      );
    });

    it("fails closed on a future idle anchor", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const sessions = createSessionStore(inspected.store, {
        clock: fixedClock(NOW),
        absoluteLifetimeMs: 10 * 60 * 1000,
        idleTimeoutMs: 1_000,
      });
      await sessions.create("future-idle", NEW_SESSION);

      const records = inspected.records();
      const [stored] = storedSessions(await records.list("session"));
      await records.put({
        ...(stored as StoredSessionFixture),
        lastSeenAt: "2026-07-27T12:05:00.000Z",
      });

      expect(
        await sessions.get("future-idle", "2026-07-27T12:00:02.000Z"),
      ).toBeNull();
      expect(await sessions.purgeExpired("2026-07-27T12:00:02.000Z")).toBe(0);
      expect(storedSessions(await records.list("session"))).toHaveLength(0);
    });

    it("fails closed on malformed revocation timestamps", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const sessions = createSessionStore(inspected.store, {
        clock: fixedClock(NOW),
      });
      await sessions.create("malformed-revocation-seed", NEW_SESSION);

      const records = inspected.records();
      const [revocation] = storedRevocations(await records.list("session"));
      await records.put({
        ...(revocation as StoredRevocationFixture),
        revokedThrough: "not-a-time",
      });

      await expect(
        sessions.create("malformed-revocation-new", NEW_SESSION),
      ).rejects.toThrow("Stored session revocation state is invalid.");
    });

    it("recovers an expired stranded revocation guard", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const sessions = createSessionStore(inspected.store, {
        clock: fixedClock(NOW),
      });
      await sessions.create("stranded-revocation-old", NEW_SESSION);

      const records = inspected.records();
      const [revocation] = storedRevocations(await records.list("session"));
      await records.put({
        ...(revocation as StoredRevocationFixture),
        revoking: true,
        activeRevocations: 1,
        revocationToken: "stranded-token",
        leaseExpiresAt: "2026-07-27T11:59:59.000Z",
      });

      await expect(
        sessions.create("stranded-revocation-blocked", NEW_SESSION),
      ).rejects.toThrow("Session issuance overlapped principal revocation.");
      expect(await sessions.destroyAllForPrincipal(PRINCIPAL)).toBe(1);
      const issuerAfterRecovery = createSessionStore(inspected.store, {
        clock: fixedClock("2026-07-27T12:00:00.001Z"),
      });
      await expect(
        issuerAfterRecovery.create("stranded-revocation-new", NEW_SESSION),
      ).resolves.toMatchObject(NEW_SESSION);
    });

    it("keeps an active guard closed against a clock past its lease", async () => {
      const base = backend.freshStore();
      let listEntered!: () => void;
      let releaseList!: () => void;
      const listStarted = new Promise<void>((resolve) => {
        listEntered = resolve;
      });
      const listRelease = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      let pauseList = true;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async list(partition) {
          const listed = await collection.list(partition);
          if (pauseList) {
            pauseList = false;
            listEntered();
            await listRelease;
          }
          return listed;
        },
      }));
      const revoker = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      // A full guard lease ahead of the revoker: expiry read from an issuer's
      // own clock would call this freshly taken guard abandoned.
      const issuerPastLease = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T13:00:00.000Z"),
      });
      await revoker.create("skewed-lease-old", NEW_SESSION);

      const revocation = revoker.destroyAllForPrincipal(PRINCIPAL);
      await listStarted;
      await expect(
        issuerPastLease.create("skewed-lease-new", NEW_SESSION),
      ).rejects.toThrow("Session issuance overlapped principal revocation.");
      releaseList();

      await expect(revocation).resolves.toBe(1);
      expect(await revoker.get("skewed-lease-old", NOW)).toBeNull();
      expect(
        await issuerPastLease.get(
          "skewed-lease-new",
          "2026-07-27T13:00:00.000Z",
        ),
      ).toBeNull();
    });

    it("fails closed instead of moving the idle anchor backward", async () => {
      const inspected = inspectStorage(backend.freshStore());
      const sessions = createSessionStore(inspected.store, {
        clock: fixedClock(NOW),
      });
      await sessions.create("clock-skew", NEW_SESSION);

      expect(
        await sessions.get("clock-skew", "2026-07-27T11:59:00.000Z"),
      ).toBeNull();

      expect(
        storedSessions(await inspected.records().list("session")),
      ).toHaveLength(0);
    });

    it("lazily removes a dead record and sweeps abandoned records", async () => {
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
        absoluteLifetimeMs: 1_000,
        idleTimeoutMs: 1_000,
      });
      await sessions.create("lazy", NEW_SESSION);
      await sessions.create("swept", NEW_SESSION);
      const later = "2026-07-27T12:00:01.000Z";

      expect(await sessions.get("lazy", later)).toBeNull();
      expect(await sessions.purgeExpired(later)).toBe(1);
      expect(await sessions.purgeExpired(later)).toBe(0);
    });

    it("revokes every matching principal with honest counts and aggregate logs", async () => {
      const { logger, entries } = recordingLogger();
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
        logger,
      });
      await sessions.create("principal-a-1", NEW_SESSION);
      await sessions.create("principal-a-2", NEW_SESSION);
      await sessions.create("principal-b", {
        principalId: OTHER_PRINCIPAL,
        data: "other",
      });

      expect(await sessions.destroyAllForPrincipal(PRINCIPAL)).toBe(2);
      expect(await sessions.destroyAllForPrincipal(PRINCIPAL)).toBe(0);
      expect(await sessions.get("principal-a-1", NOW)).toBeNull();
      expect(await sessions.get("principal-b", NOW)).not.toBeNull();
      expect(entries).toEqual([
        {
          level: "info",
          message: "Sessions revoked",
          fields: { destroyed: 2 },
        },
        {
          level: "info",
          message: "Sessions revoked",
          fields: { destroyed: 0 },
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain("principal-a");
      expect(JSON.stringify(entries)).not.toContain(PRINCIPAL);
    });

    it("logs only the aggregate purge outcome", async () => {
      const { logger, entries } = recordingLogger();
      const sessions = createSessionStore(backend.freshStore(), {
        clock: fixedClock(NOW),
        logger,
        absoluteLifetimeMs: 1,
      });
      await sessions.create("purge-log-id", NEW_SESSION);

      expect(await sessions.purgeExpired("2026-07-27T12:00:00.001Z")).toBe(1);
      expect(entries).toEqual([
        {
          level: "info",
          message: "Expired sessions purged",
          fields: { purged: 1 },
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain("purge-log-id");
    });

    it("swallows touch and lazy-delete failures", async () => {
      let failUpdate = true;
      let failDelete = false;
      const base = backend.freshStore();
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async update(...arguments_) {
          if (failUpdate) {
            throw new Error("touch unavailable");
          }
          return collection.update(...arguments_);
        },
        async deleteIfUnchanged(...arguments_) {
          if (failDelete) {
            throw new Error("cleanup unavailable");
          }
          return collection.deleteIfUnchanged(...arguments_);
        },
      }));
      const inspected = inspectStorage(wrapped);
      const sessions = createSessionStore(inspected.store, {
        clock: fixedClock(NOW),
        absoluteLifetimeMs: 1_000,
      });
      await sessions.create("best-effort", NEW_SESSION);

      await expect(
        sessions.get("best-effort", "2026-07-27T12:00:00.500Z"),
      ).resolves.not.toBeNull();

      failUpdate = false;
      failDelete = true;
      await expect(
        sessions.get("best-effort", "2026-07-27T12:00:01.000Z"),
      ).resolves.toBeNull();
      expect(
        storedSessions(await inspected.records().list("session")),
      ).toHaveLength(1);
    });

    it("never exposes the raw id through storage, logs, or component errors", async () => {
      const rawId = "never-print-this-session-id";
      const observed: unknown[] = [];
      const base = backend.freshStore();
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async insertIfAbsent(value) {
          observed.push(value);
          return collection.insertIfAbsent(value);
        },
        async getVersioned(key) {
          observed.push(key);
          return collection.getVersioned(key);
        },
        async delete(key) {
          observed.push(key);
          return collection.delete(key);
        },
      }));
      const { logger, entries } = recordingLogger();
      const sessions = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
        logger,
      });
      await sessions.create(rawId, NEW_SESSION);
      let collision: unknown;
      try {
        await sessions.create(rawId, NEW_SESSION);
      } catch (error) {
        collision = error;
      }
      await sessions.get(rawId, NOW);
      await sessions.observe(rawId, NOW);
      await sessions.destroy(rawId);
      await sessions.destroyAllForPrincipal(PRINCIPAL);
      await sessions.purgeExpired(NOW);

      expect(JSON.stringify(observed)).not.toContain(rawId);
      expect(JSON.stringify(entries)).not.toContain(rawId);
      expect(String(collision)).not.toContain(rawId);
    });

    it("lets destroy win a race with a touch without resurrection", async () => {
      const base = backend.freshStore();
      let race = false;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async update(key, decide, options) {
          if (race) {
            race = false;
            await collection.delete(key);
          }
          return collection.update(key, decide, options);
        },
      }));
      const sessions = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      await sessions.create("touch-destroy-race", NEW_SESSION);
      race = true;

      expect(
        await sessions.get("touch-destroy-race", "2026-07-27T13:00:00.000Z"),
      ).not.toBeNull();
      expect(await sessions.get("touch-destroy-race", NOW)).toBeNull();
    });

    it("lets a revival win a race with the hygiene sweep", async () => {
      const base = backend.freshStore();
      let revive = false;
      const sweepAt = "2026-07-27T12:00:01.000Z";
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async deleteIfUnchanged(key, version) {
          if (revive) {
            revive = false;
            await collection.update(key, (current) =>
              current === null
                ? { action: "keep" }
                : {
                    action: "write",
                    value: {
                      ...current,
                      lastSeenAt: "2026-07-27T12:00:00.750Z",
                    },
                  },
            );
          }
          return collection.deleteIfUnchanged(key, version);
        },
      }));
      const sessions = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
        absoluteLifetimeMs: 10_000,
        idleTimeoutMs: 1_000,
      });
      await sessions.create("sweep-revival-race", NEW_SESSION);
      revive = true;

      expect(await sessions.purgeExpired(sweepAt)).toBe(0);
      expect(await sessions.get("sweep-revival-race", sweepAt)).not.toBeNull();
    });

    it("lets principal revocation win a race with a touch", async () => {
      const base = backend.freshStore();
      let touchBeforeDelete = false;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async delete(key) {
          if (touchBeforeDelete) {
            touchBeforeDelete = false;
            await collection.update(key, (current) =>
              current === null
                ? { action: "keep" }
                : {
                    action: "write",
                    value: {
                      ...current,
                      lastSeenAt: "2026-07-27T13:00:00.000Z",
                    },
                  },
            );
          }
          return collection.delete(key);
        },
      }));
      const sessions = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      await sessions.create("revocation-touch-race", NEW_SESSION);
      touchBeforeDelete = true;

      expect(await sessions.destroyAllForPrincipal(PRINCIPAL)).toBe(1);
      expect(await sessions.get("revocation-touch-race", NOW)).toBeNull();
    });

    it("rejects session creation that overlaps principal revocation", async () => {
      const base = backend.freshStore();
      let createDuringRevocation:
        PromiseSettledResult<SessionRecord> | undefined;
      let issuer: ReturnType<typeof createSessionStore>;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async list(partition) {
          const listed = await collection.list(partition);
          if (createDuringRevocation === undefined) {
            createDuringRevocation = await Promise.resolve(
              issuer.create("revocation-create-race-new", NEW_SESSION),
            ).then(
              (value): PromiseFulfilledResult<SessionRecord> => ({
                status: "fulfilled",
                value,
              }),
              (reason): PromiseRejectedResult => ({
                status: "rejected",
                reason,
              }),
            );
          }
          return listed;
        },
      }));
      const revoker = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      issuer = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T12:00:00.001Z"),
      });
      await revoker.create("revocation-create-race-old", NEW_SESSION);

      expect(await revoker.destroyAllForPrincipal(PRINCIPAL)).toBe(1);
      expect(createDuringRevocation?.status).toBe("rejected");
      if (createDuringRevocation?.status !== "rejected") {
        throw new Error(
          "Expected overlapping session creation to be rejected.",
        );
      }
      expect(String(createDuringRevocation?.reason)).toContain(
        "Session issuance overlapped principal revocation.",
      );
      expect(await revoker.get("revocation-create-race-old", NOW)).toBeNull();
      expect(
        await revoker.get(
          "revocation-create-race-new",
          "2026-07-27T12:00:00.001Z",
        ),
      ).toBeNull();

      const afterRevocation = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T12:00:00.002Z"),
      });
      await expect(
        afterRevocation.create("revocation-create-after", NEW_SESSION),
      ).resolves.toMatchObject(NEW_SESSION);
    });

    it("rejects overlapping creation even when the issuer clock is ahead", async () => {
      const base = backend.freshStore();
      let newSessionHash = "";
      let revoker: ReturnType<typeof createSessionStore>;
      let revokeDuringCreate = false;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async transact(partition, actions) {
          if (
            revokeDuringCreate &&
            actions.length === 2 &&
            actions[1]?.action === "insert" &&
            (actions[1].value as StoredFixture).kind === "session" &&
            (actions[1].value as StoredSessionFixture).idHash === newSessionHash
          ) {
            revokeDuringCreate = false;
            await revoker.destroyAllForPrincipal(PRINCIPAL);
          }
          return collection.transact(partition, actions);
        },
      }));
      revoker = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      const issuerWithAheadClock = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T13:00:00.000Z"),
      });
      await revoker.create("skewed-revocation-old", NEW_SESSION);
      newSessionHash = await sha256("skewed-revocation-new");
      revokeDuringCreate = true;

      await expect(
        issuerWithAheadClock.create("skewed-revocation-new", NEW_SESSION),
      ).rejects.toThrow("Session issuance overlapped principal revocation.");
      expect(await revoker.get("skewed-revocation-old", NOW)).toBeNull();
      expect(
        await revoker.get("skewed-revocation-new", "2026-07-27T13:00:00.000Z"),
      ).toBeNull();

      await expect(
        issuerWithAheadClock.create("skewed-revocation-after", NEW_SESSION),
      ).resolves.toMatchObject(NEW_SESSION);
    });

    it("does not report success after a newer revoker replaces its lease", async () => {
      const base = backend.freshStore();
      let firstListEntered!: () => void;
      let releaseFirstList!: () => void;
      const firstListStarted = new Promise<void>((resolve) => {
        firstListEntered = resolve;
      });
      const firstListRelease = new Promise<void>((resolve) => {
        releaseFirstList = resolve;
      });
      let pauseFirstList = true;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async list(partition) {
          if (pauseFirstList) {
            pauseFirstList = false;
            firstListEntered();
            await firstListRelease;
          }
          return collection.list(partition);
        },
      }));
      const firstRevoker = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      const replacementRevoker = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T12:00:00.001Z"),
      });
      const issuerAfterReplacement = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T13:00:00.002Z"),
      });
      await firstRevoker.create("replaced-revocation-old", NEW_SESSION);

      const firstRevocation = firstRevoker.destroyAllForPrincipal(PRINCIPAL);
      await firstListStarted;
      await expect(
        replacementRevoker.destroyAllForPrincipal(PRINCIPAL),
      ).resolves.toBe(1);
      await issuerAfterReplacement.create(
        "replaced-revocation-new",
        NEW_SESSION,
      );
      releaseFirstList();

      await expect(firstRevocation).rejects.toThrow(
        "Session revocation state changed too many times.",
      );
      expect(
        await issuerAfterReplacement.get(
          "replaced-revocation-new",
          "2026-07-27T13:00:00.002Z",
        ),
      ).not.toBeNull();
    });

    it("allows a failed revocation to be retried before its lease expires", async () => {
      const base = backend.freshStore();
      let failFirstList = true;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async list(partition) {
          if (failFirstList) {
            failFirstList = false;
            throw new Error("list unavailable");
          }
          return collection.list(partition);
        },
      }));
      const failingRevoker = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      const retryingRevoker = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T12:00:00.001Z"),
      });
      await failingRevoker.create("retry-revocation-old", NEW_SESSION);

      await expect(
        failingRevoker.destroyAllForPrincipal(PRINCIPAL),
      ).rejects.toThrow("list unavailable");
      await expect(
        retryingRevoker.destroyAllForPrincipal(PRINCIPAL),
      ).resolves.toBe(1);
      expect(
        await retryingRevoker.get(
          "retry-revocation-old",
          "2026-07-27T12:00:00.001Z",
        ),
      ).toBeNull();
    });

    it("lets a newer revocation safely replace an active guard", async () => {
      const base = backend.freshStore();
      let firstListEntered!: () => void;
      let releaseFirstList!: () => void;
      const firstListStarted = new Promise<void>((resolve) => {
        firstListEntered = resolve;
      });
      const firstListRelease = new Promise<void>((resolve) => {
        releaseFirstList = resolve;
      });
      let pauseFirstList = true;
      const wrapped = wrapSessionCollection(base, (collection) => ({
        ...collection,
        async list(partition) {
          const listed = await collection.list(partition);
          if (pauseFirstList) {
            pauseFirstList = false;
            firstListEntered();
            await firstListRelease;
          }
          return listed;
        },
      }));
      const firstRevoker = createSessionStore(wrapped, {
        clock: fixedClock(NOW),
      });
      const replacementRevoker = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T12:00:00.002Z"),
      });
      const issuerDuringReplacement = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T12:00:00.003Z"),
      });
      await firstRevoker.create("overlapping-revocation-old", NEW_SESSION);

      const firstRevocation = firstRevoker.destroyAllForPrincipal(PRINCIPAL);
      await firstListStarted;
      await expect(
        replacementRevoker.destroyAllForPrincipal(PRINCIPAL),
      ).resolves.toBe(1);
      await expect(
        issuerDuringReplacement.create(
          "overlapping-revocation-new",
          NEW_SESSION,
        ),
      ).resolves.toMatchObject(NEW_SESSION);

      releaseFirstList();
      await expect(firstRevocation).rejects.toThrow(
        "Session revocation state changed too many times.",
      );

      const issuerAfterOverlap = createSessionStore(wrapped, {
        clock: fixedClock("2026-07-27T12:00:00.004Z"),
      });
      await expect(
        issuerAfterOverlap.create("overlapping-revocation-after", NEW_SESSION),
      ).resolves.toMatchObject(NEW_SESSION);
    });
  });
}

it("sends one physical Azure GET and no write for each observation after table initialization", async () => {
  const requests: string[] = [];
  const sessions = createSessionStore(freshAzureStore(requests), {
    clock: fixedClock(NOW),
    idleTimeoutMs: 1_000,
  });
  const rawId = "physical-observation-secret";
  await sessions.create(rawId, NEW_SESSION);
  for (const [sessionId, now, live] of [
    [rawId, NOW, true],
    [rawId, "2026-07-27T12:00:01.000Z", false],
    ["physical-missing", NOW, false],
  ] as const) {
    requests.length = 0;
    expect((await sessions.observe(sessionId, now)) !== null).toBe(live);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/^GET /u);
    expect(requests[0]).toContain(await sha256(sessionId));
    expect(requests[0]).not.toContain(sessionId);
  }
});

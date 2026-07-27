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

function freshAzureStore(): Store {
  tableCounter += 1;
  const table = `sessions${tableCounter}t${process.pid}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
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

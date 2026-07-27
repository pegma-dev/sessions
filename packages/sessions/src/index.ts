import {
  noopLogger,
  systemClock,
  type Clock,
  type IsoTimestamp,
  type Logger,
  type PrincipalId,
} from "@pegma/spine";
import {
  defineCollection,
  type EntityKey,
  type Store,
  type StoredRecord,
  type VersionedRecord,
} from "@pegma/storage-core";

const SESSION_PARTITION = "session";
const DEFAULT_ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const NO_PRINCIPAL_REVOCATION = "0000-01-01T00:00:00.000Z" as IsoTimestamp;
const MAX_REVOCATION_TRANSACTION_ATTEMPTS = 8;
const REVOCATION_GUARD_LEASE_MS = 60 * 60 * 1000;
const CANONICAL_ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The caller-owned fields from which a session record is created. */
export interface NewSession {
  readonly principalId: PrincipalId;
  /** Opaque, host-encoded data. This package never inspects it. */
  readonly data: string;
}

/** A live or stored server-side session, without its credential-derived key. */
export interface SessionRecord extends NewSession {
  readonly createdAt: IsoTimestamp;
  /** Absolute boundary. The session is dead at this instant, not after it. */
  readonly expiresAt: IsoTimestamp;
  /** Idle-timeout anchor, advanced best-effort by successful reads. */
  readonly lastSeenAt: IsoTimestamp;
}

/** Operations over server-side session records. */
export interface SessionStore {
  /** Creates a record under a SHA-256 hash of `sessionId`. */
  create(sessionId: string, session: NewSession): Promise<SessionRecord>;

  /**
   * Returns the initially validated record when live, otherwise null.
   *
   * The idle touch is best-effort. The returned record deliberately does not
   * claim that touch succeeded.
   */
  get(sessionId: string, now?: IsoTimestamp): Promise<SessionRecord | null>;

  /** Idempotently revokes one session. */
  destroy(sessionId: string): Promise<void>;

  /** Revokes every session owned by `principalId`. */
  destroyAllForPrincipal(principalId: PrincipalId): Promise<number>;

  /** Conditionally removes records that are dead at `now`. */
  purgeExpired(now?: IsoTimestamp): Promise<number>;
}

export interface SessionStoreOptions {
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Defaults to seven days. Must be positive and finite. */
  readonly absoluteLifetimeMs?: number;
  /** Defaults to twelve hours. Must be positive and finite. */
  readonly idleTimeoutMs?: number;
}

interface StoredSessionRecord extends SessionRecord {
  readonly kind: "session";
  readonly idHash: string;
}

interface PrincipalRevocationRecord {
  readonly kind: "principalRevocation";
  readonly principalHash: string;
  readonly principalId: PrincipalId;
  readonly revoking: boolean;
  readonly activeRevocations: number;
  readonly revocationToken: string;
  readonly leaseExpiresAt: IsoTimestamp;
  readonly revocationGeneration: number;
  readonly revokedThrough: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

type StoredSessionEntry = StoredSessionRecord | PrincipalRevocationRecord;

function sessionKey(idHash: string): EntityKey {
  return { partition: SESSION_PARTITION, id: `session:${idHash}` };
}

function principalRevocationKey(principalHash: string): EntityKey {
  return {
    partition: SESSION_PARTITION,
    id: `principal-revocation:${principalHash}`,
  };
}

const sessionCollection = defineCollection<StoredSessionEntry>({
  name: "sessions",
  key: (value) =>
    value.kind === "session"
      ? sessionKey(value.idHash)
      : principalRevocationKey(value.principalHash),
  codec: {
    encode: (value): StoredRecord => ({
      kind: value.kind,
      ...(value.kind === "session"
        ? {
            idHash: value.idHash,
            principalId: value.principalId,
            data: value.data,
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
            lastSeenAt: value.lastSeenAt,
          }
        : {
            principalHash: value.principalHash,
            principalId: value.principalId,
            revoking: String(value.revoking),
            activeRevocations: String(value.activeRevocations),
            revocationToken: value.revocationToken,
            leaseExpiresAt: value.leaseExpiresAt,
            revocationGeneration: String(value.revocationGeneration),
            revokedThrough: value.revokedThrough,
            updatedAt: value.updatedAt,
          }),
    }),
    decode: (record) => {
      if (String(record["kind"] ?? "session") === "principalRevocation") {
        return {
          kind: "principalRevocation",
          principalHash: String(record["principalHash"] ?? ""),
          principalId: String(record["principalId"] ?? "") as PrincipalId,
          revoking: String(record["revoking"] ?? "") === "true",
          activeRevocations: Number(record["activeRevocations"] ?? 0),
          revocationToken: String(record["revocationToken"] ?? ""),
          leaseExpiresAt: String(
            record["leaseExpiresAt"] ?? NO_PRINCIPAL_REVOCATION,
          ),
          revocationGeneration: Number(record["revocationGeneration"] ?? 0),
          revokedThrough: String(record["revokedThrough"] ?? ""),
          updatedAt: String(record["updatedAt"] ?? ""),
        };
      }
      return {
        kind: "session",
        idHash: String(record["idHash"] ?? ""),
        principalId: String(record["principalId"] ?? "") as PrincipalId,
        data: String(record["data"] ?? ""),
        createdAt: String(record["createdAt"] ?? ""),
        expiresAt: String(record["expiresAt"] ?? ""),
        lastSeenAt: String(record["lastSeenAt"] ?? ""),
      };
    },
  },
});

function isSessionRecord(
  record: StoredSessionEntry,
): record is StoredSessionRecord {
  return record.kind === "session";
}

function isPrincipalRevocationRecord(
  record: StoredSessionEntry,
): record is PrincipalRevocationRecord {
  return record.kind === "principalRevocation";
}

function checkedRevocationState(
  state: VersionedRecord<StoredSessionEntry> | null,
): VersionedRecord<PrincipalRevocationRecord> | null {
  if (state === null) {
    return null;
  }
  if (!isPrincipalRevocationRecord(state.value)) {
    throw new Error("Stored session revocation state is invalid.");
  }
  if (
    !Number.isFinite(timestamp(state.value.revokedThrough)) ||
    !Number.isFinite(timestamp(state.value.leaseExpiresAt)) ||
    !Number.isFinite(timestamp(state.value.updatedAt))
  ) {
    throw new Error("Stored session revocation state is invalid.");
  }
  if (
    !Number.isInteger(state.value.activeRevocations) ||
    state.value.activeRevocations < 0 ||
    !Number.isInteger(state.value.revocationGeneration) ||
    state.value.revocationGeneration < 0 ||
    state.value.revoking !== state.value.activeRevocations > 0
  ) {
    throw new Error("Stored session revocation state is invalid.");
  }
  if (state.value.revocationToken.length > 0 !== state.value.revoking) {
    throw new Error("Stored session revocation state is invalid.");
  }
  return { value: state.value, version: state.version };
}

function publicRecord(record: StoredSessionRecord): SessionRecord {
  return {
    principalId: record.principalId,
    data: record.data,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
  };
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}

function timestamp(value: IsoTimestamp): number {
  if (!CANONICAL_ISO_TIMESTAMP.test(value)) {
    return Number.NaN;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    return Number.NaN;
  }
  try {
    return new Date(at).toISOString() === value ? at : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function isoTimestamp(value: IsoTimestamp, message: string): IsoTimestamp {
  const at = timestamp(value);
  if (!Number.isFinite(at)) {
    throw new Error(message);
  }
  try {
    return new Date(at).toISOString();
  } catch {
    throw new Error("Session timestamps are outside the supported date range.");
  }
}

function laterTimestamp(
  first: IsoTimestamp,
  second: IsoTimestamp,
): IsoTimestamp {
  const firstAt = timestamp(first);
  const secondAt = timestamp(second);
  if (!Number.isFinite(firstAt)) {
    return second;
  }
  if (!Number.isFinite(secondAt)) {
    return first;
  }
  return new Date(Math.max(firstAt, secondAt)).toISOString();
}

function timestampPlus(value: IsoTimestamp, ms: number): IsoTimestamp {
  const at = timestamp(value);
  const later = at + ms;
  if (!Number.isFinite(at) || !Number.isFinite(later)) {
    throw new Error("Clock returned an invalid timestamp.");
  }
  try {
    return new Date(later).toISOString();
  } catch {
    throw new Error("Session timestamps are outside the supported date range.");
  }
}

async function retryRevocationTransaction(attempt: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(50, attempt * 5) + Math.random() * 5),
  );
}

function throwRevocationTransactionLimit(): never {
  throw new Error("Session revocation state changed too many times.");
}

/**
 * The only liveness predicate.
 *
 * Both the hot read and the hygiene sweep call this function. Invalid time
 * from either the clock or storage fails closed.
 */
function isLive(
  record: SessionRecord,
  now: IsoTimestamp,
  idleTimeoutMs: number,
): boolean {
  const at = timestamp(now);
  const created = timestamp(record.createdAt);
  const expires = timestamp(record.expiresAt);
  const lastSeen = timestamp(record.lastSeenAt);
  return (
    Number.isFinite(at) &&
    Number.isFinite(created) &&
    Number.isFinite(expires) &&
    Number.isFinite(lastSeen) &&
    created <= lastSeen &&
    lastSeen <= at &&
    at < expires &&
    at - lastSeen < idleTimeoutMs
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashSessionId(sessionId: string): Promise<string> {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Session id must be a non-empty string.");
  }
  return sha256Hex(sessionId);
}

async function hashPrincipalId(principalId: PrincipalId): Promise<string> {
  return sha256Hex(principalId);
}

function createdRecord(
  session: NewSession,
  now: IsoTimestamp,
  absoluteLifetimeMs: number,
): SessionRecord {
  const at = timestamp(now);
  const expires = at + absoluteLifetimeMs;
  if (!Number.isFinite(at) || !Number.isFinite(expires)) {
    throw new Error("Clock returned an invalid timestamp.");
  }

  let expiresAt: IsoTimestamp;
  try {
    expiresAt = new Date(expires).toISOString();
  } catch {
    throw new Error("Session timestamps are outside the supported date range.");
  }

  return Object.freeze({
    principalId: session.principalId,
    data: session.data,
    createdAt: new Date(at).toISOString(),
    expiresAt,
    lastSeenAt: new Date(at).toISOString(),
  });
}

function initialRevocationRecord(
  principalId: PrincipalId,
  principalHash: string,
  now: IsoTimestamp,
): PrincipalRevocationRecord {
  const updatedAt = isoTimestamp(now, "Clock returned an invalid timestamp.");
  return {
    kind: "principalRevocation",
    principalHash,
    principalId,
    revoking: false,
    activeRevocations: 0,
    revocationToken: "",
    leaseExpiresAt: NO_PRINCIPAL_REVOCATION,
    revocationGeneration: 0,
    revokedThrough: NO_PRINCIPAL_REVOCATION,
    updatedAt,
  };
}

function beginRevocationRecord(
  principalId: PrincipalId,
  principalHash: string,
  now: IsoTimestamp,
  revocationToken: string,
  previous?: PrincipalRevocationRecord,
): PrincipalRevocationRecord {
  const updatedAt = isoTimestamp(now, "Clock returned an invalid timestamp.");
  return {
    kind: "principalRevocation",
    principalHash,
    principalId,
    revoking: true,
    activeRevocations: 1,
    revocationToken,
    leaseExpiresAt: timestampPlus(updatedAt, REVOCATION_GUARD_LEASE_MS),
    revocationGeneration: (previous?.revocationGeneration ?? 0) + 1,
    revokedThrough:
      previous === undefined
        ? updatedAt
        : laterTimestamp(previous.revokedThrough, updatedAt),
    updatedAt,
  };
}

function finishRevocationRecord(
  principalId: PrincipalId,
  principalHash: string,
  now: IsoTimestamp,
  previous: PrincipalRevocationRecord,
): PrincipalRevocationRecord {
  const updatedAt = isoTimestamp(now, "Clock returned an invalid timestamp.");
  return {
    kind: "principalRevocation",
    principalHash,
    principalId,
    revoking: false,
    activeRevocations: 0,
    revocationToken: "",
    leaseExpiresAt: NO_PRINCIPAL_REVOCATION,
    revocationGeneration: previous.revocationGeneration,
    revokedThrough: laterTimestamp(previous.revokedThrough, updatedAt),
    updatedAt,
  };
}

/**
 * Binds the session port to an injected storage backend.
 *
 * Storage selection belongs to the host: the same port works over the memory
 * store and the Azure Tables adapter.
 */
export function createSessionStore(
  store: Store,
  options: SessionStoreOptions = {},
): SessionStore {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const absoluteLifetimeMs = positiveFinite(
    options.absoluteLifetimeMs ?? DEFAULT_ABSOLUTE_LIFETIME_MS,
    "absoluteLifetimeMs",
  );
  const idleTimeoutMs = positiveFinite(
    options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    "idleTimeoutMs",
  );
  const sessions = store.collection(sessionCollection);

  return {
    async create(sessionId, session) {
      const idHash = await hashSessionId(sessionId);
      const record = createdRecord(session, clock.now(), absoluteLifetimeMs);
      const principalHash = await hashPrincipalId(session.principalId);
      const stateKey = principalRevocationKey(principalHash);
      let observedRevocationGeneration: number | undefined;

      for (
        let attempt = 1;
        attempt <= MAX_REVOCATION_TRANSACTION_ATTEMPTS;
        attempt += 1
      ) {
        const state = checkedRevocationState(
          await sessions.getVersioned(stateKey),
        );
        const revocation = state === null ? undefined : state.value;
        const revocationGeneration = revocation?.revocationGeneration ?? 0;
        if (
          observedRevocationGeneration !== undefined &&
          observedRevocationGeneration !== revocationGeneration
        ) {
          throw new Error("Session issuance overlapped principal revocation.");
        }
        observedRevocationGeneration ??= revocationGeneration;
        if (revocation?.revoking === true) {
          throw new Error("Session issuance overlapped principal revocation.");
        }

        const outcome = await sessions.transact(SESSION_PARTITION, [
          state === null
            ? {
                action: "insert",
                value: initialRevocationRecord(
                  session.principalId,
                  principalHash,
                  record.createdAt,
                ),
              }
            : {
                action: "putIfUnchanged",
                value: state.value,
                version: state.version,
              },
          {
            action: "insert",
            value: { kind: "session", ...record, idHash },
          },
        ]);

        if (outcome.committed) {
          return record;
        }
        if (
          outcome.reason === "exists" &&
          (outcome.failedAction === 1 ||
            (await sessions.get(sessionKey(idHash))) !== null)
        ) {
          throw new Error("Session id collision.");
        }
        if (outcome.failedAction === 0) {
          await retryRevocationTransaction(attempt);
          continue;
        }
        if (outcome.reason === "changed") {
          await retryRevocationTransaction(attempt);
          continue;
        }
        if (outcome.reason === "exists") {
          await retryRevocationTransaction(attempt);
          continue;
        }
        throwRevocationTransactionLimit();
      }
      throwRevocationTransactionLimit();
    },

    async get(sessionId, now = clock.now()) {
      const key = sessionKey(await hashSessionId(sessionId));
      const versioned = await sessions.getVersioned(key);
      if (versioned === null || !isSessionRecord(versioned.value)) {
        return null;
      }

      const initiallyRead = versioned.value;
      if (!isLive(initiallyRead, now, idleTimeoutMs)) {
        await sessions
          .deleteIfUnchanged(key, versioned.version)
          .catch(() => undefined);
        return null;
      }

      await sessions
        .update(key, (current) => {
          if (
            current === null ||
            !isSessionRecord(current) ||
            !isLive(current, now, idleTimeoutMs)
          ) {
            return { action: "keep" };
          }
          const currentLastSeen = timestamp(current.lastSeenAt);
          const at = timestamp(now);
          if (at <= currentLastSeen) {
            return { action: "keep" };
          }
          return {
            action: "write",
            value: {
              ...current,
              lastSeenAt: new Date(at).toISOString(),
            },
          };
        })
        .catch(() => undefined);

      return publicRecord(initiallyRead);
    },

    async destroy(sessionId) {
      await sessions.delete(sessionKey(await hashSessionId(sessionId)));
    },

    async destroyAllForPrincipal(principalId) {
      const principalHash = await hashPrincipalId(principalId);
      const stateKey = principalRevocationKey(principalHash);
      const revocationToken = crypto.randomUUID();
      const startedAt = isoTimestamp(
        clock.now(),
        "Clock returned an invalid timestamp.",
      );

      let markedRevoking = false;
      for (
        let attempt = 1;
        attempt <= MAX_REVOCATION_TRANSACTION_ATTEMPTS;
        attempt += 1
      ) {
        const state = checkedRevocationState(
          await sessions.getVersioned(stateKey),
        );
        const revocation = state === null ? undefined : state.value;
        const outcome = await sessions.transact(SESSION_PARTITION, [
          state === null
            ? {
                action: "insert",
                value: beginRevocationRecord(
                  principalId,
                  principalHash,
                  startedAt,
                  revocationToken,
                ),
              }
            : {
                action: "putIfUnchanged",
                value: beginRevocationRecord(
                  principalId,
                  principalHash,
                  startedAt,
                  revocationToken,
                  revocation,
                ),
                version: state.version,
              },
        ]);
        if (outcome.committed) {
          markedRevoking = true;
          break;
        }
        await retryRevocationTransaction(attempt);
      }
      if (!markedRevoking) {
        throwRevocationTransactionLimit();
      }

      async function requireOwnedRevocation(): Promise<void> {
        const state = checkedRevocationState(
          await sessions.getVersioned(stateKey),
        );
        if (
          state === null ||
          state.value.revocationToken !== revocationToken ||
          !state.value.revoking
        ) {
          throwRevocationTransactionLimit();
        }
      }

      let destroyed = 0;
      for (const record of await sessions.list(SESSION_PARTITION)) {
        if (!isSessionRecord(record)) {
          continue;
        }
        if (record.principalId !== principalId) {
          continue;
        }
        await requireOwnedRevocation();
        if (await sessions.delete(sessionKey(record.idHash))) {
          destroyed += 1;
        }
      }

      let clearedRevoking = false;
      for (
        let attempt = 1;
        attempt <= MAX_REVOCATION_TRANSACTION_ATTEMPTS;
        attempt += 1
      ) {
        const state = checkedRevocationState(
          await sessions.getVersioned(stateKey),
        );
        if (state === null) {
          throw new Error("Stored session revocation state is invalid.");
        }
        const revocation = state.value;
        if (revocation.revocationToken !== revocationToken) {
          throwRevocationTransactionLimit();
        }
        const outcome = await sessions.transact(SESSION_PARTITION, [
          {
            action: "putIfUnchanged",
            value: finishRevocationRecord(
              principalId,
              principalHash,
              laterTimestamp(startedAt, clock.now()),
              revocation,
            ),
            version: state.version,
          },
        ]);
        if (outcome.committed) {
          clearedRevoking = true;
          break;
        }
        await retryRevocationTransaction(attempt);
      }
      if (!clearedRevoking) {
        throwRevocationTransactionLimit();
      }

      logger.log("info", "Sessions revoked", { destroyed });
      return destroyed;
    },

    async purgeExpired(now = clock.now()) {
      let purged = 0;
      for (const versioned of await sessions.listVersioned(SESSION_PARTITION)) {
        if (!isSessionRecord(versioned.value)) {
          continue;
        }
        if (isLive(versioned.value, now, idleTimeoutMs)) {
          continue;
        }
        if (
          await sessions.deleteIfUnchanged(
            sessionKey(versioned.value.idHash),
            versioned.version,
          )
        ) {
          purged += 1;
        }
      }
      logger.log("info", "Expired sessions purged", { purged });
      return purged;
    },
  };
}

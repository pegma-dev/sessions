# @pegma/sessions

## Not an auth solution

This package is a server-side session record store. It does not implement
authentication, OIDC, OAuth, cookies, CSRF protection, or token storage. The
host authenticates a principal and supplies an opaque session id; this package
remembers the resulting `PrincipalId` and one host-encoded `data` string.

Raw session ids are SHA-256 hashed before every storage operation. Records have
both an absolute lifetime and an idle timeout, and principal-wide revocation
uses unconditional deletion so it wins races with activity. A per-principal
revocation boundary also rejects session creation that overlaps a sign-out
everywhere operation.

```ts
import { createSessionStore } from "@pegma/sessions";

const sessions = createSessionStore(store);
const record = await sessions.create(rawSessionId, {
  principalId,
  data: JSON.stringify({ displayName }),
});
```

Defaults are seven days absolute and twelve hours idle. Supply
`absoluteLifetimeMs` and `idleTimeoutMs` to `createSessionStore` to configure
positive finite durations. A single `session` partition holds session rows and
per-principal revocation guard rows; principal-wide revocation and expiry
purges scan that partition, so this package is intended for hosts with
thousands, not millions, of live sessions.

Session data must never contain IdP access tokens, refresh tokens, or any other
credential re-presentable to another service.

## Activity reads and read-only checks

Use `get(rawSessionId)` when the request should count as activity. It reads a
live session and attempts a best-effort idle touch; a dead row is lazily
deleted best-effort. The returned record describes the initial validated
snapshot and does not claim that the touch succeeded.

Use `observe(rawSessionId)` when a later check needs current session identity
and liveness without extending activity:

```ts
const admitted = await sessions.get(rawSessionId);
if (admitted === null) return refuseRequest();

// Before a later protected step, read current session state again.
const current = await sessions.observe(rawSessionId);
if (current === null) return refuseRequest();
// The host must also revalidate current identity and permissions.
```

`observe` hashes the id and performs one fresh keyed backend read per call. It
returns a `SessionRecord` when live or null when missing, revoked, or rejected
by the timestamp and expiry checks shared with `get` and the sweep. These
checks validate lifecycle timestamps, not principal claims or host data.
It does not touch the idle anchor, delete dead rows, or cache earlier results.
Backend read failures reject so the host can fail closed. Keep `get` for the
activity that should renew idle expiry; repeated observations alone will not
keep a session alive.

Both methods observe the default clock after the awaited storage read. An
explicit `now` is used unchanged; hosts seeking current liveness should omit
it. Absolute and idle boundaries are exclusive: a session is dead at either
boundary. Invalid timestamps and idle anchors ahead of the observing clock
fail closed, including clock rollback or host skew.

A returned record is a snapshot, not a lock or a cross-store transaction.
Revocation after that backend snapshot can overlap a successful result, and
the session may expire before later work completes. Hosts retain their
closing checks and any required identity, permission, and commit-time fences.

## Development

Node.js 22 or 24 is required for local development (the same versions CI
runs). The published `engines` field remains `>=22`. Node 25 and later do
not bundle Corepack, so install it first if `corepack` is missing. The test
suite starts a real Azurite Table service and runs the same behavioral cases
over memory and Azure Tables.

```sh
npm install -g corepack
corepack enable
pnpm install
pnpm run format:check
pnpm run check
pnpm test
```

## License

MIT. Copyright (c) 2026 RetireGolden, LLC.

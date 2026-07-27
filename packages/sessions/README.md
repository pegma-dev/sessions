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

## Development

Node.js 22 or newer is required. The test suite starts a real Azurite Table
service and runs the same behavioral cases over memory and Azure Tables.

```sh
npm ci
npm run format:check
npm run check
npm test
```

## License

MIT. Copyright (c) 2026 RetireGolden, LLC.

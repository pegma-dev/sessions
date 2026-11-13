# Sessions

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Server-side session records for [Pegma](https://pegma.dev) components: hashed
identifiers, absolute plus idle expiry, and principal-wide revocation.

## Not an auth solution

This is the **session record store** behind BFF-style auth — the durable
answer to "is this session id live, and who is it?". It does not
authenticate anyone: no OIDC handshake, no IdP integration, no cookie
handling, no CSRF defense. Your host owns its login flow and its HTTP
surface; this store remembers the result.

> [!IMPORTANT]
> `@pegma/sessions` remains early `0.x`: the public API is not stable, and
> it is not ready for production use. Published versions are listed on
> [npm](https://www.npmjs.com/package/@pegma/sessions).

The `0.2.1` change observes the default clock after awaited reads and sweeps.
With a consistent advancing clock, a concurrent touch observed in that snapshot
is no longer mistaken for a future timestamp merely because the operation
started earlier. Explicit caller-supplied timestamps keep their semantics.

Clock rollback and skew between hosts remain fail-closed: an idle anchor ahead
of the observing clock is dead under the single liveness predicate and may be
conditionally deleted. This change adds no clock-skew tolerance or coordination.
Source versions describe behavior; publication is recorded in
[GitHub releases](https://github.com/pegma-dev/sessions/releases).

The `0.3.0` API adds `observe(sessionId, now?)`: a fresh liveness-checked read
without an idle touch or cleanup write. Hosts can keep `get` for initial
admission and use `observe` for closing checks that must not count as activity.
Both use the same expiry predicate and clock semantics. Each result is a
snapshot; later revocation or expiry is still possible. See the
[package README](packages/sessions/README.md) for usage.

Current status: the record-store package is published on npm, the first
consumer migration is merged in
[RetireGolden/retiregolden.org#54](https://github.com/RetireGolden/retiregolden.org/pull/54).
pegma.dev is the second consumer: its production Identity Worker resolves the
opaque browser cookie through `@pegma/sessions` before revalidating Identity
and Authorization claims at `/api/secure`.
That first version was recovered through a manual maintainer publish after
its GitHub release workflow failed, so it has no npm provenance. Releases
from `0.1.1` onward use protected signed tags and the repository's OIDC-only
prepared-artifact workflow.

What it does own, it owns opinionatedly:

- **Hashed identifiers, non-optionally** — the raw session id is hashed
  (SHA-256) at the port and never reaches a storage key, so a leaked table,
  backup, or log hands out no live sessions. There is no option to skip
  this; that option would be the vulnerability.
- **Two expiries, one predicate** — an absolute lifetime _and_ an idle
  timeout, enforced through a single liveness function shared by the read
  path and the sweep, with malformed timestamps and future idle anchors
  failing closed. A stolen-but-parked session dies at the idle window, not
  days later.
- **Revocation that means it** — `destroyAllForPrincipal` is literal "signed
  out everywhere" (account deletion, incident response), and its deletes are
  deliberately unconditional: a session touched mid-revocation still dies.
  A durable per-principal revocation boundary also refuses session creation
  that overlaps the revocation window, so a concurrent sign-in cannot sneak
  behind a list snapshot.
  The hygiene sweep is the opposite — version-conditional, so a session that
  came back to life mid-sweep survives. Keeping those two rules opposite is
  the design.
- **Activity reads that garbage-collect and never resurrect** — a dead row found
  by `get` is lazily purged; the idle-anchor touch declines to write back a
  session a concurrent destroy just removed, and a failed touch never fails
  the request.

One data rule, stated up front: session records hold identity claims and
host data, **never tokens**. Nothing re-presentable to another service
belongs at rest here — that is the point of the BFF pattern this store
serves.

## Where it fits

`@pegma/sessions` declares one collection over an injected
[`@pegma/storage-core`](https://github.com/pegma-dev/storage-core) `Store`,
and takes time, logging, and `PrincipalId` from
[`@pegma/spine`](https://github.com/pegma-dev/spine). It does not depend on
authorization-core — a session resolving to a `PrincipalId` is the join
point, not a coupling.

The design is extracted from the production BFF session store in the
[RetireGolden account API](https://github.com/RetireGolden/retiregolden.org/tree/main/api),
the ecosystem's reference application. See
[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the model, the design
decisions, and the delivery phases.

## License

MIT © RetireGolden, LLC

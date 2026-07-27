# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Sessions is the server-side session record store of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared contracts live in
`@pegma/spine`; persistence in `@pegma/storage-core`; identity and
permissions in `@pegma/authorization-core`. They publish under the `@pegma`
scope, one repository per component.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

## Hard rules

**Raw session ids never touch storage, logs, or errors.** Hashing at the port
is unconditional and non-configurable. Any change that lets a raw id reach a
storage key, a log line, or an exception message reintroduces the exact
vulnerability this component exists to close. There is no legitimate feature
request that needs it.

**Liveness has one predicate.** The absolute expiry and the idle timeout are
enforced by a single function used by the read path and the sweep. Do not add
a second place that decides whether a session is alive; two deciders will
disagree, and the disagreement is a security bug. Non-finite or malformed
timestamps fail closed as dead.

**The two delete paths have opposite rules — keep them opposite.**
Revocation (`destroy`, `destroyAllForPrincipal`) deletes unconditionally: it
must win races against concurrent touches. Principal-wide revocation also uses
its guard row to reject creates that overlap the revocation window; do not
replace that with a list-only implementation. The hygiene sweep deletes
version-conditionally: it must lose races against concurrent revival. A
refactor that unifies them breaks one of the two.

**Touches never fail requests and never resurrect.** The idle-anchor touch is
best-effort (a storage blip must not sign a user out) and runs through a
decider that keeps when the record is gone (a `get` racing a `destroy` must
not recreate the session).

**No tokens at rest, and no authentication code — ever.** The record holds
identity claims and one host-encoded data field. No IdP access or refresh
tokens; no OIDC, cookie, or CSRF logic in this repository regardless of how
often hosts ask. Those are host-surface concerns, and pulling them in here
turns a small credential store into a competing auth framework.

**Test against the real backend, including the races.** The suite runs over
`createMemoryStore()` and against the Azure Tables adapter with real Azurite,
and the race cases — touch-vs-destroy, sweep-vs-revival, revocation-vs-touch
— are the specification, not optional extras.

## Reference implementation

The design is extracted from the store half of `api/src/lib/session.js` in
the RetireGolden account API (its cookie/OIDC/CSRF halves deliberately stay
there). When behaviour here is ambiguous, that implementation and its tests
are the precedent.

# Sessions Project Plan

## Status

**Stage:** First public `0.x` is published as `@pegma/sessions` version
`0.1.0`.
Phase 1 is merged on `main`
([PR #1](https://github.com/pegma-dev/sessions/pull/1), `f5ea435`,
2026-07-27): the record store, package scaffolding, and memory/Azurite race
suite described below are the repository baseline. Phase 2 is merged in the
first consumer
([RetireGolden/retiregolden.org#54](https://github.com/RetireGolden/retiregolden.org/pull/54)).
`@pegma/sessions@0.1.0` is published on npm, with its public API still
unstable. Its GitHub release was created from a lightweight tag on 2026-07-27
and the release workflow initially failed because the package name did not
exist. A maintainer subsequently published the exact expected tarball
manually. The registry version has the release commit as `gitHead`, but no npm
provenance. Both the npm version and lightweight tag are immutable audit
history; releases from `v0.1.1` onward use protected signed annotated tags and
the OIDC-only prepared-artifact workflow.

**Initial reference application:** RetireGolden, whose account API carries the
production-tested implementation this component is extracted from
([`retiregolden.org/api/src/lib/session.js`](https://github.com/RetireGolden/retiregolden.org/blob/main/api/src/lib/session.js)
— the session-store half of a BFF web session, hardened on stage by real login
traffic).

**License:** MIT

**Naming and origin:** "Sessions" here means the **server-side session record
store**: the durable answer to "is this session id live, and who is it?". It
is deliberately not an authentication solution — no OIDC handshake, no cookie
handling, no CSRF machinery. Those are host concerns (and in the reference
application they remain host code by design). The git history begins at this
extraction; nothing was ever published under another name.

**Storage:** `@pegma/sessions` declares one collection over an injected
`@pegma/storage-core` `Store`, takes time from a `@pegma/spine` `Clock`, and
identifies session owners by `@pegma/spine` `PrincipalId`. Dependencies are
pinned exactly. It does not depend on `@pegma/authorization-core`; a session
resolving to a `PrincipalId` is the join point, not a coupling.

## Vision

Anything doing BFF-style auth — a browser holding a first-party cookie whose
value means nothing without a server-side record — needs the same store: an
unforgeable identifier, two independent expiries, revocation that actually
revokes, and hygiene for the rows nobody comes back for. Every hand-rolled
version makes the same three mistakes: it stores the session id in the clear
(so a leaked table hands out live sessions), it forgets the idle timeout (so
a stolen-but-parked session lives out its full window), and its "sign out
everywhere" quietly misses sessions (so account deletion isn't).

One session record store, with the security details people omit when writing
it themselves built in and non-optional — so a Pegma host gets "a database
leak yields no usable session" for free, rather than as a code-review catch.

## Problem statement

A session record store looks like a cache and must be built like a credential
store. The specifics that separate the two:

1. **The stored id is a bearer credential.** Whatever is in the table's key
   column, presented as a cookie, IS the session. Stored in the clear, a
   backup, a log line, or a leaked table is a bag of live logins.
2. **Expiry is two clocks, not one.** An absolute lifetime bounds how long any
   session can exist; an idle timeout kills a session nobody is using well
   before that. Enforcing only the first leaves stolen idle sessions alive
   for days; enforcing them in two places lets the read path and the sweep
   disagree about what "dead" means.
3. **Revocation has consequences.** "Sign out everywhere" backs account
   deletion and incident response; it must be literal. And the small races —
   a session touched concurrently with its own destruction, a sweep
   enumerating a session that just became live again — decide whether
   revocation and hygiene are trustworthy or approximately so.

The reference implementation answers all three with `@pegma/storage-core`
primitives: SHA-256 of the id as the storage key, one liveness predicate
shared by every path, best-effort idle touches through an `update` decider
that refuses to resurrect a destroyed session, unconditional deletes for
revocation, and versioned conditional deletes for the sweep.

## Core model

### Session record

Keyed by the **hash** of the session id. The component owns the lifecycle
fields: the id hash, the owning `PrincipalId`, created-at, absolute
expires-at, and the last-seen timestamp that anchors the idle timeout.
Everything else a host wants in the session — an identity snapshot, display
fields, whatever its request path needs without a second read — rides in one
host-encoded data field (the `@pegma/audit` precedent: one encoded field, not
flattened; the component never inspects it).

### Liveness

One predicate answers "is this record live at this instant?", enforcing both
the absolute expiry and the idle timeout, with malformed or non-finite
timestamps and future idle anchors failing closed as dead. The read path, the
sweep, and nothing else: every consumer of "is it alive" goes through the
same function, so the two can never disagree.

### The port

- `create(sessionId, record)` — persist a new session under the hashed id.
  Atomic insert; a collision (256-bit ids: effectively never) is refused, not
  overwritten.
- `get(sessionId, now?)` — the hot path. Returns the record if live; returns
  null for unknown, expired, or idled-out sessions and lazily deletes the
  dead row (version-conditionally, best-effort). On a live hit, touches the
  idle anchor through a decider that declines to resurrect a session a
  concurrent destroy just removed; a failed touch never fails the request.
- `destroy(sessionId)` — delete; already-gone is success, not an error.
- `destroyAllForPrincipal(principalId)` — sign out everywhere. Lists the
  partition and filters on the record's principal; deletes are deliberately
  **unconditional**, because a session touched concurrently must still die.
  A per-principal revocation guard row refuses creates that overlap the
  revocation window, so revocation is not limited to one list snapshot.
- `purgeExpired(now?)` — versioned sweep of dead rows the lazy purge never
  saw; a session touched after enumeration (live again) fails its
  conditional delete and survives.

### The data boundary

The record holds identity claims and host data — **never tokens**. No IdP
access token, refresh token, or anything re-presentable to another service
belongs at rest here; the whole point of the BFF pattern this store serves is
that there is nothing to leak and no refresh logic to get wrong. The
component cannot see inside the host's encoded field, so this is a documented
contract rather than an enforced one — stated on the front page.

## Design decisions

### Identifiers are hashed at the boundary, unconditionally

The component takes the raw session id at the port and hashes it (SHA-256)
before anything touches storage; a raw id never reaches a storage key, a log,
or an error. This is not configurable — an option to skip hashing is an
option to reintroduce the vulnerability the component exists to close. This
is exactly the detail implementers omit, and it is the component's reason to
exist as a package rather than a recipe.

### Two expiries, one predicate

Absolute lifetime and idle timeout are both mandatory (defaults from the
reference implementation: 7 days absolute, 12 hours idle; both
configurable). There is no sliding absolute window: a session cannot be
extended past its absolute expiry by activity, because "re-authenticate at
least weekly" is the security property the absolute clock exists to provide.

### One partition, and honest about the scan

All sessions share a single partition. This is forced, not chosen: `get`
holds only the session id — the principal is unknowable at read time, so a
per-principal partition cannot be addressed on the hot path — and the sweep
must enumerate every session, which storage-core does per-partition.
`destroyAllForPrincipal` therefore lists the partition and filters
client-side. That is the same I/O the reference implementation's server-side
filter produced anyway (a non-indexed filter is a partition scan wherever it
runs), but it sets a scale envelope: the store is right for hosts whose
_live-session count_ is bounded — thousands, not millions. A principal index
is deliberately not built: it adds a write to the hot path and fixes neither
the sweep nor the read. Documented, revisited only with a real consumer over
the envelope.

### Revocation deletes unconditionally; hygiene deletes conditionally

The two delete paths have opposite correctness rules, and keeping them
opposite is the design. `destroyAllForPrincipal` must kill a session even if
it was touched mid-enumeration — revocation wins races. `purgeExpired` must
_not_ kill a session touched mid-enumeration — hygiene loses races. An
implementation that unifies them gets one of the two wrong.
The per-principal revocation guard is part of the same invariant: a create
that races the revocation window is refused instead of surviving behind an
old list snapshot.

### Reads garbage-collect, and never resurrect

A dead row found by `get` is purged lazily (version-conditionally, failure
swallowed — cleanup must never fail a request), so the sweep is a backstop
rather than the mechanism. The idle-anchor touch runs through a decider that
keeps when the record has vanished: a `get` racing a `destroy` must not write
the session back into existence. Both behaviours came out of the reference
implementation's review history; they are precedent, not invention.

### Time and logging are injected

A `@pegma/spine` `Clock` supplies every instant (the port's `now?` parameters
exist for tests and for hosts that batch), and notable outcomes (sweep
counts, revocation counts) report through the spine `Logger` port.

## Scope

### In scope

- The session record store: create, liveness-checked reads with idle
  touch, destroy, principal-wide revocation, expiry sweep.
- Mandatory id hashing, dual expiry, the single liveness predicate.
- The host data field with a host-supplied codec fragment.
- Conformance-style tests over `createMemoryStore()` and against the Azure
  Tables adapter (real Azurite, per ecosystem rule) — including the race
  tests: touch-vs-destroy, sweep-vs-revival, revocation-vs-touch, and
  revocation-vs-create.

### Non-goals

- **Authentication.** No OIDC/OAuth handshake, no IdP integration, no login
  flow. The host authenticates; this store remembers.
- **Cookies and HTTP.** No cookie parsing, serialization, `__Host-` prefixes,
  SameSite policy, or CSRF defense. Those are host-surface decisions (the
  reference application's are documented there and worth reading — but they
  are not portable code).
- **Token storage.** No IdP tokens at rest, ever; see the data boundary.
- **Stateless/JWT sessions.** A signed-token session model has no server
  record and needs none of this; it is a different trade, not a feature gap.
- **Session-fixation ceremony.** Issuing a fresh id at privilege change is
  the host's login flow's job; the store just makes create/destroy cheap
  enough that there is no excuse not to.
- **Remember-me / long-lived refresh credentials.** Different lifetime,
  different threat model, different store.

## Package architecture

One package: `packages/sessions` publishing `@pegma/sessions`. Dependencies:
`@pegma/spine` (PrincipalId, IsoTimestamp, Clock, Logger) and
`@pegma/storage-core` (collection definition, injected Store), pinned
exactly. TypeScript, vitest, the ecosystem's standard repo layout.

The collection is named `sessions`, one `session` partition — the same names
the reference application already uses, though its flattened record shape
differs from the component's (lifecycle fields plus one encoded host field),
so its existing rows do not survive the swap. Consequence: deploying the
swap signs every active session out, once. For the reference application
that is a non-event (sessions are ephemeral by definition; everyone
re-authenticates through the IdP without a prompt), and the storage
migration already established the posture: state it, schedule it, never
paper over it.

## Delivery phases

### Phase 1 — the record store, merged

Merged in [PR #1](https://github.com/pegma-dev/sessions/pull/1). This phase
extracted the store half of the reference implementation into TypeScript
against spine and storage-core: the port above, mandatory hashing, the
liveness predicate, the host data field, and the full race-test suite over
memory and real Azurite. The cookie/OIDC halves of the reference file
explicitly stayed behind. Exit was met: the suite was green both ways, and
the README leads with what the component is not (an auth solution).

### Phase 2 — first consumer, merged

RetireGolden swaps `session.js`'s store internals for `@pegma/sessions`,
keeping its cookie, CSRF, and OIDC layers untouched. The first-consumer PR
merged in
[RetireGolden/retiregolden.org#54](https://github.com/RetireGolden/retiregolden.org/pull/54).
The swap signs existing server-side sessions out once, which is routine for
ephemeral BFF sessions. Exit was met: the application's session and BFF test
suites passed with the store injected, and `destroyAllForPrincipal` is
exercised by the account-deletion path end to end.

### Phase 3 — second consumer, shape's verdict

The support desk is the natural second consumer: agent sign-in is BFF-shaped,
and agent sessions give `destroyAllForPrincipal` a sharper meaning (role
revoked → sessions die, alongside authorization-core's 60-second permission
cache bound). This phase judges the host-data-field ergonomics (is one
encoded field pleasant enough, or does it push hosts toward abuse?) and
whether a `listForPrincipal` read belongs in the port (see Open questions).

### Phase 4 — first package published; future path hardened

First public `0.x` is published as `@pegma/sessions` version `0.1.0`, pinned
to the spine and storage-core versions it was verified against. It was
published manually from the exact expected bytes after the original workflow
failed, and consequently has no npm provenance.

The next release is at least `v0.1.1` and uses the hardened path: a protected
signed annotated tag on `origin/main`, an unprivileged preparation job that
records and uploads the exact tarball, and a minimal `npm-publish`
environment job using trusted-publisher OIDC. Breaking changes remain
permitted until real consumers say otherwise.

## Open questions

**`listForPrincipal`.** An "active sessions" screen (show the user their
devices, revoke one) needs to _read_ a principal's sessions, and the scan
that powers `destroyAllForPrincipal` could just as well return them. Lean
**yes, eventually** — same I/O, real product need, and refusing it invites
hosts to reimplement the scan wrong — but not until a consumer actually
builds that screen (Phase 3 at the earliest). It would surface hashed ids
only; the raw id of any session other than the caller's own is unknowable by
design, so revoking a listed session works by hash, not by id.

**Host data: resolved in Phase 1.** The public record has one encoded `data`
field (audit precedent, crisp boundary). Letting the host contribute codec
fields into the component's collection would read better in host code but
dissolve the boundary that keeps the component ignorant of host data.

**Anonymous sessions.** Carts and previews want session records before any
principal exists. `PrincipalId` would become nullable and
`destroyAllForPrincipal` would skip them. Lean **defer**: no Pegma consumer
needs it yet, and nullable-principal is a one-way door better opened by a
real requirement.

**Touch write amplification.** Every live `get` writes the idle anchor. The
reference application accepts this (its traffic is modest); a busier host
might want a touch floor ("don't re-touch within N minutes"), trading idle
precision for writes. Cheap to add behind a config default of 0; decide when
a consumer measures it.

## Near-term backlog

1. Phase 1 is merged on `main`; do not keep dispatching record-store
   extraction work from this plan.
2. Observe the RetireGolden production deploy path for the merged consumer
   swap; keep cookies, CSRF, OIDC, and HTTP behavior as host code.
3. Dispatch Phase 3 only when the support desk or another real BFF-shaped
   consumer is ready to test the host-data-field shape and any
   `listForPrincipal` demand.
4. Configure and verify npm trusted publishing, then release the next version
   (at least `v0.1.1`) from a protected signed annotated tag. Never move or
   recreate the legacy lightweight `v0.1.0` tag or attempt to replace its
   immutable npm version.

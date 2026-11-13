# @pegma/sessions v0.3.0

Add `SessionStore.observe(sessionId, now?)` for fresh liveness and identity
checks that must not extend activity. It hashes the raw session id and performs
one keyed backend read, then applies the existing liveness predicate. It returns
the public record when live and null when missing, revoked, or rejected by the
shared timestamp and expiry checks. Those checks validate lifecycle timestamps,
not principal claims or host data. It never touches the idle anchor or lazily
deletes a dead row; backend read failures propagate.

The default clock is observed after the awaited read, matching `get`; explicit
instants retain their existing semantics. Use `get` for activity such as initial
request admission and `observe` for later closing checks. Each observation reads
the backend afresh, but its result is a snapshot, not a lock against subsequent
revocation or expiry. Hosts still own current identity and permission checks.

The `0.3.0` minor version reflects the public `SessionStore` interface expansion
under `0.x`. Existing `get`, revocation, expiry cleanup, storage schema, and
runtime dependency pins retain their behavior. Memory and real Azure Tables
tests cover read-only operation, exact expiry, clock observation, fresh
revocation, concurrent touches, and snapshot limits. On the initialized Azure
Tables adapter's no-retry path, the tests observe one physical GET per
observation, including dead and missing records. Adapter retries can issue
additional physical requests.

# @pegma/sessions v0.2.1

Fix default clock observation around awaited session reads and expiry sweeps.
Default read time is observed after hashing and the initial storage read;
default sweep time is observed after the versioned list snapshot. With a
consistent advancing clock, a concurrent touch in that snapshot is no longer
misclassified as a future idle anchor merely because the operation began
before the touch. Sessions that expire during these awaits are rejected or
purged using the later observation.

Explicit caller-supplied instants retain their existing semantics. Clock
rollback or skew between hosts can still produce a future idle anchor, which
fails closed and may be conditionally deleted. There is no skew tolerance or
clock-coordination API. The single liveness predicate, malformed timestamp
refusal, conditional hygiene deletion, unconditional revocation and best-effort
non-resurrecting touch remain in place. No storage call, schema, runtime
dependency or public method is added. Memory and Azurite regressions cover the
concurrent touches, awaited expiry, clock observation and explicit-time behavior.

# @pegma/sessions v0.2.0

A dependency-alignment release: `@pegma/storage-core` advances from `0.3.0` to
`0.4.0`, matching the pin already used by webhooks, mail, and identity so host
dependency trees resolve a single storage-core and no longer need an npm
override to avoid two incompatible `Store` types. The
`@pegma/storage-azure-tables` test backend advances to `0.4.0` alongside it.

No behavioural or public API change in the session port itself. The version
advances to `0.2.0` (rather than a patch) because hosts composing this package
must now supply a storage-core `0.4.0` `Store`, which is a breaking composition
change under `0.x` semver. The full memory and Azurite race suite passes
against storage-core `0.4.0` unchanged.

# @pegma/sessions v0.2.1 candidate

Unpublished patch candidate for concurrent session reads and expiry sweeps.
Default read time is now observed after hashing and the initial storage read;
default sweep time is observed after the versioned list snapshot. A concurrent
successful read can advance the idle anchor without causing an older operation
to mistake that live session for an invalid future record and delete it. A
session that expires during the awaited initial read is rejected.

Explicit caller-supplied instants retain their existing semantics. The single
liveness predicate, malformed/future-timestamp refusal, conditional hygiene
deletion, unconditional revocation and best-effort non-resurrecting touch remain
in place. No extra storage read, schema, runtime dependency or public method is
introduced. Real Memory and Azurite regressions cover the overlapping reads,
overlapping sweep, expiry handoff and explicit-time compatibility.

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

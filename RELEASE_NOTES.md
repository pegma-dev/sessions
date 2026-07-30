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

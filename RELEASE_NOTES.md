# @pegma/sessions v0.1.1

The first release through the hardened path: a protected signed annotated tag,
a prepared artifact, and npm trusted publishing. `0.1.0` was published manually
after its release workflow failed and has no provenance; see
`docs/RELEASING.md`.

No behavioural change. The 2026-07-29 remediation pass over
`docs/securityscan.md` disputed all seven findings with reasoning recorded
inline — every suggested remediation would have traded a theoretical problem for
a real one — so nothing in the session port changed.

- Documents why the principal-revocation guard lease is deliberately never
  consulted: expiry judged from an issuing host's clock lets a host running
  fast release a guard taken seconds ago and issue a session inside the
  revocation window. Recovery from a faulted revocation stays a repeat
  `destroyAllForPrincipal`.
- Adds a test pinning that an issuer whose clock is a full lease ahead of the
  revoker is still refused while a revocation is in flight.
- Records the 2026-07-29 dispositions in `docs/securityscan.md` and reformats
  that file so `npm run format:check` passes.

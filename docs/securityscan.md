# Security Scan — @pegma/sessions

Repository-wide security review performed 2026-07-28. Findings are logged
incrementally as the scan progresses. Scope: `packages/`, `test/`, `scripts/`,
`.github/`, root config.

Review criteria include the hard rules in `AGENTS.md`:

- Raw session ids must never reach storage keys, logs, or errors (hashing at
  the port is unconditional).
- Liveness decided by a single predicate (absolute expiry + idle timeout);
  malformed timestamps fail closed.
- Revocation deletes unconditionally; sweep deletes version-conditionally;
  the two paths must not be unified.
- Touches are best-effort and must never resurrect a destroyed session.
- No tokens at rest; no OIDC/cookie/CSRF/auth logic in this package.
- Release workflow: signed annotated tag, prepared artifact, npm trusted
  publishing, no token fallback.

## Findings

### 1. Stale principal-revocation guard permanently blocks session creation (Low — availability)

- **Severity:** Low (availability / liveness, not confidentiality or integrity)
- **File:** `packages/sessions/src/index.ts`
- **Evidence:**
  - `beginRevocationRecord` (lines 383–406) sets `leaseExpiresAt` to
    `updatedAt + REVOCATION_GUARD_LEASE_MS` (1 hour, line 22).
  - `leaseExpiresAt` is validated for finiteness in `checkedRevocationState`
    (lines 186–192) but is **never read anywhere else** — no code path checks
    whether the lease has expired to take over or clear an abandoned guard.
  - If `destroyAllForPrincipal` faults after committing the `revoking: true`
    marker (lines 583–624) but before the finish phase (lines 653–689) — e.g.
    process crash, storage outage mid-loop — the guard row stays
    `revoking: true` indefinitely.
  - Every subsequent `create` for that principal then throws
    `"Session issuance overlapped principal revocation."` (lines 476–478)
    forever. There is no self-healing path; only an operator retrying
    `destroyAllForPrincipal` (which can re-take the guard via
    `putIfUnchanged`) recovers the principal.
- **Exploitability:** Not directly attacker-triggerable — requires an internal
  fault at the wrong moment. But a host that calls
  `destroyAllForPrincipal` in response to a security event (account
  compromise → revoke all sessions) and crashes mid-operation leaves that
  principal unable to ever log in again, which converts a partial failure
  into a permanent lockout. The 1-hour lease constant strongly suggests lease
  takeover was intended but never implemented.
- **Suggested remediation:** In `create` and in the begin phase of
  `destroyAllForPrincipal`, treat a guard with `revoking === true` and
  `leaseExpiresAt <= now` as abandoned and allow it to be superseded (with a
  generation bump), matching the documented lease semantics.

### 2. Corrupted revocation guard row is an unrecoverable hard failure (Low — availability)

- **Severity:** Low (availability)
- **File:** `packages/sessions/src/index.ts`
- **Evidence:** `checkedRevocationState` (lines 177–206) throws
  `"Stored session revocation state is invalid."` on any malformed guard row
  (bad timestamps, negative counters, token/revoking mismatch). Both `create`
  (line 464) and `destroyAllForPrincipal` (line 589) call it before doing
  anything else, and neither has a recovery branch — a single bit-rotted or
  partially written guard row bricks session creation for that principal
  permanently, with no operator-facing way to reset it through the public
  API.
- **Exploitability:** Requires storage corruption or a bug in a future writer;
  not externally triggerable. Contrast with the session-record decode path,
  which fails closed gracefully (bad timestamps → `isLive` false → record
  treated as dead and conditionally removed, lines 536–541). The guard-row
  path has no equivalent graceful degradation.
- **Suggested remediation:** Consider treating an invalid guard row as
  absence of revocation state (fail-open for creates) or providing a
  guarded repair path, since the guard is an anti-overlap optimization and
  its corruption currently fails in the most restrictive way possible.

### 3. Release pipeline — verified sound, two informational observations (Informational)

- **Severity:** Informational
- **Files:** `.github/workflows/publish.yml`, `scripts/release-packages.mjs`
- **Verified good:**
  - All actions pinned by full-length SHA (`publish.yml` lines 28, 50, 76,
    101, 108, 114; `ci.yml` lines 29, 32).
  - Trusted-publisher OIDC only: `publishPreparedRelease` refuses to run when
    `NODE_AUTH_TOKEN` is set (`release-packages.mjs` lines 530–532) and
    enforces npm >= 11.5.1 (lines 494–506). No token fallback exists.
  - Signed annotated tag enforced: tag must be an annotated tag object
    (lines 109–117), `git verify-tag` must pass against a reviewed
    allowed-signers file (lines 134–141), checkout commit, tag target, and
    release event commit compared with `timingSafeEqual` (lines 126–133).
  - Publish job does not rebuild: it verifies the prepared tarball's
    sha512/sha1 against the manifest (lines 469–475) before publishing.
  - Runtime dependencies must be pinned to exact stable semver
    (lines 195–201); package `files` allowlist restricted to `dist/`
    (lines 186–194); tarball contents verified against the allowlist
    (lines 287–307).
  - Workflow permissions are minimal (`contents: read`; `id-token: write`
    only in the publish job, gated by the `npm-publish` environment).
- **Observation A (informational):** The prepared-artifact digest recorded in
  the prepare job's step summary (`publish.yml` line 86) is not re-verified in
  the publish job; integrity binding between jobs rests on the manifest hash
  checks, which are self-consistent within the artifact. An attacker who could
  replace the artifact between jobs would still need the manifest's
  `gitCommit`/`version` to match the signed-tag checkout, which sharply
  limits the value. Pinning `steps.upload.outputs.artifact-digest` in the
  download step would close this completely.
- **Observation B (informational):** `npm install --global npm@11.18.0`
  (`publish.yml` line 57) fetches npm itself from the registry without an
  integrity pin. Low risk given the registry's own integrity checks, and it
  runs in the prepare job (not the OIDC-enabled publish job), but it is the
  one unpinned supply-chain fetch in the release path.
- **Exploitability:** Both require prior compromise of GitHub Actions
  infrastructure or the npm registry — out of scope for ordinary threat
  models.

### 4. Vulnerable transitive dependencies via the Azurite test emulator (Low — dev-only)

- **Severity:** Low (development/test environment only; **zero** findings in
  production dependencies — `npm audit --omit=dev` reports 0
  vulnerabilities, and the published package's two runtime deps
  (`@pegma/spine@0.1.1`, `@pegma/storage-core@0.3.0`) are exact-pinned and
  clean)
- **Files:** `package.json` (devDependencies, line 31),
  `package-lock.json`
- **Evidence:** `npm audit` reports 12 vulnerabilities (5 high, 7 moderate),
  all reachable only through `azurite@^3.36.0`:
  - `brace-expansion` (high, GHSA-mh99-v99m-4gvg — DoS via unbounded
    expansion), through `rimraf → glob → minimatch`
  - `uuid` (moderate, GHSA-w5hq-g745-h8pq — missing buffer bounds check in
    v3/v5/v6), through `sequelize` and `@azure/ms-rest-js`
  - `@opentelemetry/core` (moderate, GHSA-8988-4f7v-96qf — unbounded memory
    allocation in W3C Baggage propagation), through `applicationinsights`
- **Exploitability:** Exploiting any of these requires running the vulnerable
  code with attacker-controlled input. Azurite runs only as a localhost test
  double (`test/azurite.ts` binds `127.0.0.1:10112`, spawned per test run
  with a temp workspace). Attack surface is the developer machine / CI runner
  executing tests against locally supplied fixtures — no network exposure,
  no shipped code. The published tarball contains only `dist/` (enforced by
  `verifyPackedFiles`, `scripts/release-packages.mjs` lines 287–307), so none
  of this reaches consumers.
- **Suggested remediation:** None urgent. When a fixed Azurite release line
  is available, bump the devDependency (`npm audit fix --force` currently
  wants a *downgrade* to azurite@3.33.0, which is not advisable). Consider
  running `npm audit --omit=dev` as a CI gate since production deps are the
  ones that matter for this package.

### 5. Well-known Azurite development key in tests (Informational — not a secret)

- **Severity:** Informational / none
- **File:** `packages/sessions/src/index.test.ts` lines 19–27
- **Evidence:** The connection string embeds
  `AccountKey=Eby8vdM02x...==`, the publicly documented, identical-for-everyone
  Azurite/Azure Storage Emulator development key for `devstoreaccount1`,
  pointing at `http://127.0.0.1`.
- **Exploitability:** None. It grants access only to a local emulator
  instance. Logged solely so the record shows it was reviewed and is
  deliberate.

### 6. Hard-rule compliance audit (Verified — no violations)

Each `AGENTS.md` hard rule was checked against the implementation and tests:

- **Raw session ids never touch storage, logs, or errors — PASS.** Every
  operation hashes at the port boundary: `create` (line 453), `get`
  (line 529), `destroy` (line 571). A full-repo usage trace confirms
  `sessionId` is only ever an argument to `hashSessionId`. Storage keys are
  `session:<sha256hex>`; log lines ("Sessions revoked", "Expired sessions
  purged", lines 691/713) carry only counts; error messages are static
  strings. Test at `index.test.ts` line 175 ("raw-session-secret") asserts
  the raw id does not appear in stored rows.
- **One liveness predicate — PASS.** `isLive` (lines 296–315) is the sole
  decider, called by the read path (line 536), the touch decider (line 548),
  and the sweep (line 701). Non-finite/malformed timestamps return NaN from
  `timestamp()` (lines 225–238) and fail closed.
- **Opposite delete rules — PASS.** `destroy` uses unconditional `delete`
  (line 571); `get`'s dead-record cleanup and `purgeExpired` use
  version-conditional `deleteIfUnchanged` (lines 538, 705–708), so hygiene
  loses races to concurrent revival. `destroyAllForPrincipal` deletes
  unconditionally (line 648) and uses its guard row (not a list) to reject
  overlapping creates (lines 469–478).
- **Touches never fail requests and never resurrect — PASS.** The touch runs
  through `sessions.update` whose decider returns `keep` when the record is
  gone, non-session, or dead (lines 544–551), and the whole touch is wrapped
  in `.catch(() => undefined)` (line 565). The returned record is the
  initially validated read (line 567).
- **No tokens at rest, no auth code — PASS.** The record holds
  `principalId`, host-encoded `data`, and timestamps only. No OIDC, cookie,
  CSRF, or IdP-token code exists anywhere in the package.
- **Real-backend race tests — PASS.** Suite runs over both
  `createMemoryStore()` and the Azure Tables adapter against live Azurite;
  59/59 tests pass, including the touch-vs-destroy, sweep-vs-revival, and
  revocation-vs-create race cases.

### 7. Principal ids are stored in plaintext beside their hashes (Informational — privacy/design)

- **Severity:** Informational
- **File:** `packages/sessions/src/index.ts` (codec lines 117, 125; match at
  line 644)
- **Evidence:** Session rows and revocation-guard rows store `principalId`
  in plaintext while the guard row's *key* is
  `principal-revocation:<sha256(principalId)>`. The keyed hash therefore
  provides no confidentiality — the plaintext sits in the same row — and
  `destroyAllForPrincipal` matches sessions by plaintext comparison.
- **Exploitability:** None beyond what storage-read access already grants;
  the `AGENTS.md` hard rule covers session ids (which are credentials),
  not principal ids (which are identity claims the record is defined to
  hold). Noted because principals that are email-like or otherwise
  low-entropy are also trivially brute-forceable from the hashed key, so the
  hashing of the key buys nothing and could give a false impression of
  pseudonymity. Matching by `principalHash` instead of plaintext would let
  the plaintext field be dropped if pseudonymity-at-rest ever becomes a
  goal.
- **Related note:** session-id hashing is unsalted SHA-256 (line 317). That
  is the correct choice *provided* hosts mint cryptographically random
  session ids (which they must, since the id is the credential); salting is
  unnecessary for 128+ bit entropy inputs and would complicate key
  derivation. No action.

## Summary

| # | Finding | Severity | Exploitability |
|---|---------|----------|----------------|
| 1 | Stale revocation guard blocks session creation forever; `leaseExpiresAt` never consulted | Low (availability) | Internal fault timing only |
| 2 | Corrupted revocation guard row is an unrecoverable hard failure | Low (availability) | Storage corruption only |
| 3 | Release pipeline sound; artifact digest not cross-pinned, global npm install unpinned | Informational | GitHub/npm infra compromise required |
| 4 | 12 vulnerable transitive deps via Azurite (0 in production deps) | Low (dev-only) | Localhost test execution only |
| 5 | Well-known Azurite dev key in tests | Informational | None |
| 6 | All six AGENTS.md hard rules verified — no violations | — | — |
| 7 | Principal ids plaintext beside their hashes | Informational | Requires storage read access |

**Overall assessment:** No high or medium severity vulnerabilities found.
The component's security invariants (hashed ids at the port, single liveness
predicate, opposite delete semantics, non-resurrecting touches, no auth
code) are correctly implemented and mechanically tested against real
backends. The only substantive issues are two fail-closed availability
edge cases around the principal-revocation guard row (findings 1–2), both
recoverable by operator action and neither reachable by an external
attacker. The release supply chain is unusually well hardened.

**Verification performed:** full test suite (59/59 passing, memory +
Azurite/Azure Tables backends), `npm audit` (production and full), manual
data-flow trace of `sessionId` through every public operation, review of
release script and both GitHub workflows, secret-pattern sweep of all
tracked files.

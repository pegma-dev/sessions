# Release operations

`@pegma/sessions` publishes only from reviewed artifacts. Merging a pull
request never publishes. A release starts from a stable GitHub release whose
tag was already created as a protected, signed annotated tag.

The workflow prepares and tests the package without OIDC authority, uploads
the exact tarball, and gives only the minimal publisher job `id-token: write`.
There is no npm-token or manual-dispatch fallback.

## Historical `v0.1.0` exception

`@pegma/sessions@0.1.0` is published and is the current `latest` version. It
is immutable, but it predates the hardened release path:

- the GitHub release used a lightweight tag at
  `b1b6c4d8b5342d6f2322e19e96c28767adfa7806`;
- release run
  [`30319397574`](https://github.com/pegma-dev/sessions/actions/runs/30319397574)
  passed the gate but npm returned `E404` because the package name did not
  yet exist;
- the maintainer then published the exact expected tarball manually;
- the registry records `gitHead`
  `b1b6c4d8b5342d6f2322e19e96c28767adfa7806` and publisher `nrover`; and
- the version has no npm provenance attestation.

The published tarball matches the failed release build:

```text
size       10334 bytes
SHA-1      3cd005a22ae689a43b36f1001913db6bd952b91d
SHA-256    62605728ee9e2ec3bc2be0a21e0bf0b5e9bb335064df87ac69b351c22403b4ee
integrity  sha512-iSeBfotZ+1huYxTW9tKYifHWNU6x9tUU2TQ8XvakW88/ZyMHMlxFbh52lRnFShadXrq2iS0orah4znPYRFZyRw==
```

Manual workflow-dispatch run
[`30320745746`](https://github.com/pegma-dev/sessions/actions/runs/30320745746)
subsequently found `0.1.0` on the registry and skipped it. That proves the
old workflow's existence check, not OIDC authentication or provenance.

Preserve `v0.1.0`, both runs, and the npm version as audit history. Never
move or recreate the tag, unpublish and reuse the version, or claim that
`0.1.0` has provenance. The next release must be at least `0.1.1`.

## Release invariants

The release tool verifies that:

- the private root and sole public workspace use one stable version;
- the root pins `npm@11.18.0` and the lockfile matches both manifests;
- `@pegma/sessions` is public MIT-licensed ESM for Node 22 or newer;
- runtime dependencies are pinned exactly;
- repository metadata points to `pegma-dev/sessions`;
- the package has its own README and LICENSE, a `dist`-only files allowlist,
  and a build-running `prepack`;
- the tarball contains only package metadata, README, LICENSE, and `dist`;
- every exported file exists and a clean consumer can import the package;
  and
- the prepared manifest records the exact commit, tag, file inventory,
  SHA-1, and SHA-512 integrity.

For a GitHub release, preparation additionally requires a stable annotated
`vX.Y.Z` tag signed by an approved signer. The tag must match the manifest
version, point to the checkout and release-event commit, and be contained in
`origin/main`.

## Required external configuration

Before the next release:

1. Configure the npm GitHub Actions trusted publisher for
   `@pegma/sessions`:
   - organization: `pegma-dev`
   - repository: `sessions`
   - workflow: `publish.yml`
   - environment: `npm-publish`
   - allowed action: `npm publish` only
2. Keep the GitHub `npm-publish` environment. Pegma currently has one
   maintainer, so no synthetic second-account approval is required.
3. Create the repository Actions variable `RELEASE_ALLOWED_SIGNERS`. Its
   value is the reviewed SSH allowed-signers entry, one principal and public
   key per line.
4. Create an active tag ruleset targeting `v*` that requires signatures and
   prevents tag updates, deletions, and non-fast-forward changes.

The npm CLI equivalent for trusted-publisher setup is:

```sh
npm trust github @pegma/sessions \
  --repository pegma-dev/sessions \
  --file publish.yml \
  --environment npm-publish \
  --allow-publish
npm trust list @pegma/sessions --json
```

These commands require interactive browser/2FA authentication. npm does not
validate the publisher fields when they are saved, so check every field
twice. Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another
credential fallback.

After the first OIDC release succeeds, set npm Publishing access to
"Require two-factor authentication and disallow tokens."

## Release procedure

Prepare every version from `0.1.1` onward through an ordinary pull request
that updates the root, workspace, and lockfile versions together and adds
reviewed release notes. Run the complete gate and a local release pack on
Node 22 and 24:

```sh
npm install --global npm@11.18.0
npm ci
npm run format:check
npm run check
npm test
npm run release:check
npm run release:pack -- -- --output .release
```

After merge, create and verify the tag before creating the GitHub release.
For example, for the next patch release:

```sh
git fetch origin
git switch --detach origin/main
git config gpg.format ssh
git config user.signingkey ~/.ssh/pegma-release-signing-key
git config gpg.ssh.allowedSignersFile ~/.config/pegma/release-allowed-signers
git tag --sign v0.1.1 --message "Sessions v0.1.1" HEAD
git verify-tag v0.1.1
git push origin refs/tags/v0.1.1
git fetch origin tag v0.1.1 --force
git verify-tag v0.1.1
gh release create v0.1.1 --verify-tag --title "@pegma/sessions v0.1.1" --notes-file RELEASE_NOTES.md
```

Do not let `gh release create` create a tag. Never move or recreate a release
tag; if any byte must change, prepare a new version.

## Workflow and recovery

The globally serialized preparation job:

1. checks out the fully qualified release tag and fetches `origin/main`;
2. configures the reviewed allowed-signers file;
3. uses Node 24.18.0 and npm 11.18.0;
4. runs the full gate without OIDC publication authority;
5. prepares, smoke-tests, and hashes the exact tarball; and
6. uploads `.release` for 30 days with an Actions transport digest.

Only the `npm-publish` job receives `id-token: write`. It downloads the
prepared artifact, installs no dependencies, rechecks the commit, tag,
manifest, and tarball hashes, and publishes with provenance.

If a hardened release fails, rerun its failed jobs against the unchanged tag:

- absent version: publish the prepared tarball;
- existing version with identical `dist.integrity`: verify and skip;
- existing version with different integrity: stop; or
- any registry error other than `E404`: stop.

The artifact name is stable across attempts because it uses
`github.run_id`, not `github.run_attempt`. A full rerun may prepare the same
bytes again from the same authenticated commit. If any released byte must
change, prepare a new version and signed tag.

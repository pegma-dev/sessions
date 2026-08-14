import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = {
  directory: "sessions",
  name: "@pegma/sessions",
};
const REPOSITORY_URL = "git+https://github.com/pegma-dev/sessions.git";
const REVIEWED_PNPM_VERSION = "10.34.5";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export const RELEASE_PACKAGES = [PACKAGE];

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function runNpm(arguments_, options = {}) {
  // Always invoke the npm CLI, not npm_execpath. Scripts run under pnpm set
  // npm_execpath to pnpm, and pack/publish/view must stay on reviewed npm.
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
    ...options,
    shell: process.platform === "win32",
  });
}

function parseYamlScalar(raw) {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replaceAll('\\"', '"');
  }
  return raw;
}

export function parsePnpmLockImporters(text) {
  const lockfileVersion = /^lockfileVersion:\s+['"]?([^'"\s]+)['"]?\s*$/mu.exec(
    text,
  )?.[1];
  const lines = text.split(/\r?\n/u);
  const importers = {};
  let index = lines.indexOf("importers:");
  if (index === -1) {
    return { lockfileVersion, importers };
  }
  index += 1;
  let currentImporter = null;
  let currentSection = null;
  let currentDependency = null;
  while (index < lines.length) {
    const line = lines[index];
    if (line !== "" && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    const importerMatch = /^  (\S[^:]*):\s*(?:\{\})?\s*$/u.exec(line);
    if (importerMatch !== null && !line.startsWith("    ")) {
      currentImporter = parseYamlScalar(importerMatch[1]);
      importers[currentImporter] = {};
      currentSection = null;
      currentDependency = null;
      index += 1;
      continue;
    }
    const sectionMatch =
      /^    (dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$/u.exec(
        line,
      );
    if (sectionMatch !== null && currentImporter !== null) {
      currentSection = sectionMatch[1];
      importers[currentImporter][currentSection] = {};
      currentDependency = null;
      index += 1;
      continue;
    }
    const depMatch = /^      (\S[^:]*):\s*$/u.exec(line);
    if (
      depMatch !== null &&
      currentImporter !== null &&
      currentSection !== null
    ) {
      currentDependency = parseYamlScalar(depMatch[1]);
      importers[currentImporter][currentSection][currentDependency] = {
        specifier: undefined,
        version: undefined,
      };
      index += 1;
      continue;
    }
    const fieldMatch = /^        (specifier|version):\s+(.+?)\s*$/u.exec(line);
    if (
      fieldMatch !== null &&
      currentImporter !== null &&
      currentSection !== null &&
      currentDependency !== null
    ) {
      importers[currentImporter][currentSection][currentDependency][
        fieldMatch[1]
      ] = parseYamlScalar(fieldMatch[2]);
    }
    index += 1;
  }
  return { lockfileVersion, importers };
}

function lockResolvedVersion(version) {
  return /^(\S+?)(?:\(|$)/u.exec(version)?.[1];
}

function parseSemver(version) {
  const match = STABLE_SEMVER.exec(lockResolvedVersion(version) ?? "");
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left, right) {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

function caretUpperBound(base) {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

function tildeUpperBound(base) {
  return { major: base.major, minor: base.minor + 1, patch: 0 };
}

export function resolvedVersionSatisfies(version, specifier) {
  const resolved = parseSemver(version);
  if (resolved === null || typeof specifier !== "string") return false;
  if (specifier === "*" || specifier === "x" || specifier === "X") return true;
  if (STABLE_SEMVER.test(specifier)) {
    return lockResolvedVersion(version) === specifier;
  }
  const caret = /^\^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(
    specifier,
  );
  if (caret !== null) {
    const base = parseSemver(caret[1]);
    return (
      base !== null &&
      compareSemver(resolved, base) >= 0 &&
      compareSemver(resolved, caretUpperBound(base)) < 0
    );
  }
  const tilde = /^~((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(
    specifier,
  );
  if (tilde !== null) {
    const base = parseSemver(tilde[1]);
    return (
      base !== null &&
      compareSemver(resolved, base) >= 0 &&
      compareSemver(resolved, tildeUpperBound(base)) < 0
    );
  }
  return false;
}

export function validateLockImporter(importer, manifest, location) {
  for (const section of DEPENDENCY_SECTIONS) {
    const declared = manifest[section] ?? {};
    const locked = importer?.[section] ?? {};
    const names = new Set([...Object.keys(declared), ...Object.keys(locked)]);
    for (const name of names) {
      const specifier = declared[name];
      const entry = locked[name];
      if (specifier === undefined) {
        fail(
          `${location} ${section}.${name} is not declared in the package manifest`,
        );
      }
      if (
        entry?.specifier !== specifier ||
        typeof entry.version !== "string" ||
        !resolvedVersionSatisfies(entry.version, specifier)
      ) {
        fail(
          `${location} ${section}.${name} must match its own specifier and resolved version`,
        );
      }
    }
  }
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

export function validateReleaseTag(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const type = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (type.status !== 0 || type.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  const packageDirectory = join(root, "packages", PACKAGE.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  const lock = parsePnpmLockImporters(
    await readFile(join(root, "pnpm-lock.yaml"), "utf8"),
  );

  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `pnpm@${REVIEWED_PNPM_VERSION}` ||
    rootManifest.version !== manifest.version ||
    lock.lockfileVersion !== "9.0" ||
    lock.importers["."] === undefined
  ) {
    fail(
      `the private root must share the package version and pin pnpm@${REVIEWED_PNPM_VERSION}`,
    );
  }
  validateLockImporter(
    lock.importers["."],
    rootManifest,
    "pnpm-lock.yaml importers[.]",
  );
  if (
    manifest.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== ">=22" ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `packages/${PACKAGE.directory}`
  ) {
    fail(`${PACKAGE.name} has invalid public package metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/")) ||
    typeof manifest.scripts?.prepack !== "string" ||
    !manifest.scripts.prepack.includes("build")
  ) {
    fail(`${PACKAGE.name} has an unsafe package allowlist or prepack`);
  }
  if (
    Object.values(manifest.dependencies ?? {}).some(
      (version) => !STABLE_SEMVER.test(version),
    )
  ) {
    fail(`${PACKAGE.name} runtime dependencies must be pinned exactly`);
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${PACKAGE.name} exports must point into dist`);
  }
  await stat(join(packageDirectory, "README.md"));
  await stat(join(packageDirectory, "LICENSE"));
  const packageImporter = lock.importers[`packages/${PACKAGE.directory}`];
  if (packageImporter === undefined) {
    fail(`${PACKAGE.name} is not present in pnpm-lock.yaml`);
  }
  validateLockImporter(
    packageImporter,
    manifest,
    `pnpm-lock.yaml importers[packages/${PACKAGE.directory}]`,
  );

  const publicWorkspaces = [];
  for (const entry of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const workspace = await readJson(
        join(root, "packages", entry.name, "package.json"),
      );
      if (workspace.private !== true) publicWorkspaces.push(workspace.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (publicWorkspaces.length !== 1 || publicWorkspaces[0] !== PACKAGE.name) {
    fail("public workspace inventory does not match the reviewed release list");
  }

  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "") {
      fail("release preparation requires a clean checkout");
    }
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${manifest.version}`) {
    fail(`release tag must be v${manifest.version}`);
  }
  const prerelease =
    options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
  if (prerelease === true || prerelease === "true") {
    fail("prereleases cannot publish packages");
  }
  if (options.requireReleaseTag) {
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return {
    root,
    version: manifest.version,
    manifest,
    packageDirectory,
    releaseTag,
  };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required)) {
      fail(`${manifest.name} is missing ${required}`);
    }
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !path.startsWith("dist/"),
    )
  ) {
    fail(`${manifest.name} tarball contains an unreviewed file`);
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) fail(`${manifest.name} is missing ${path}`);
  }
}

async function smokeTestTarball(tarball, manifest) {
  const directory = await mkdtemp(join(tmpdir(), "sessions-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"sessions-release-smoke","private":true,"type":"module"}\n',
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      { cwd: directory, capture: true },
    );
    for (const key of Object.keys(manifest.exports)) {
      const specifier =
        key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
      run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(specifier)})`,
        ],
        { cwd: directory, capture: true },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareRelease(options = {}) {
  const { root, version, manifest, packageDirectory, releaseTag } =
    await validateRepository(options);
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }

  runNpm(["run", "build"], { cwd: root });
  const result = runNpm(
    ["pack", packageDirectory, "--json", "--pack-destination", output],
    { cwd: root, capture: true },
  );
  const [packed] = JSON.parse(result.stdout);
  if (
    packed?.name !== manifest.name ||
    packed?.version !== version ||
    typeof packed.filename !== "string" ||
    !Array.isArray(packed.files)
  ) {
    fail("npm pack returned invalid metadata");
  }
  verifyPackedFiles(manifest, packed.files);
  const tarballPath = join(output, basename(packed.filename));
  const hashes = hashTarball(await readFile(tarballPath));
  if (
    !safeEqual(hashes.integrity, packed.integrity) ||
    !safeEqual(hashes.shasum, packed.shasum)
  ) {
    fail("tarball hashes do not match npm pack metadata");
  }
  await smokeTestTarball(tarballPath, manifest);

  const prepared = {
    schemaVersion: 1,
    version,
    gitCommit,
    releaseTag: releaseTag ?? null,
    package: {
      name: manifest.name,
      version,
      tarball: basename(tarballPath),
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
  return { manifestPath, manifest: prepared };
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runNpm(["view", spec, "dist.integrity", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      fail(`${spec} exists without dist.integrity`);
    }
    return integrity;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b/u.test(output)) return null;
  fail(`npm registry lookup failed for ${spec}:\n${output.trim()}`);
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) return "publish";
  if (safeEqual(localIntegrity, registryIntegrity)) return "skip";
  fail("the registry version exists with different tarball integrity");
}

async function verifyPreparedManifest(manifestPath) {
  const prepared = await readJson(manifestPath);
  const record = prepared.package;
  const { manifest } = await validateRepository();
  if (
    prepared.schemaVersion !== 1 ||
    !STABLE_SEMVER.test(prepared.version) ||
    !/^[0-9a-f]{40,64}$/u.test(prepared.gitCommit) ||
    !(
      prepared.releaseTag === null ||
      prepared.releaseTag === `v${prepared.version}`
    ) ||
    record?.name !== PACKAGE.name ||
    record?.version !== prepared.version ||
    typeof record.integrity !== "string" ||
    typeof record.shasum !== "string" ||
    !Array.isArray(record.files)
  ) {
    fail("prepared package manifest is invalid");
  }
  if (manifest.version !== prepared.version) {
    fail("prepared version does not match the checked-out package");
  }
  verifyPackedFiles(manifest, record.files);
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: defaultRoot(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, prepared.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const expectedTarball = `${PACKAGE.name
    .slice(1)
    .replace("/", "-")}-${record.version}.tgz`;
  if (record.tarball !== expectedTarball) {
    fail("prepared tarball name is invalid");
  }
  const tarball = resolve(dirname(manifestPath), record.tarball);
  if (dirname(tarball) !== resolve(dirname(manifestPath))) {
    fail("prepared tarball must be beside the package manifest");
  }
  const hashes = hashTarball(await readFile(tarball));
  if (
    !safeEqual(hashes.integrity, record.integrity) ||
    !safeEqual(hashes.shasum, record.shasum)
  ) {
    fail("prepared tarball has changed");
  }
  return prepared;
}

export async function inspectPreparedRegistry(options = {}) {
  const manifestPath = resolve(
    options.manifest ?? ".release/package-manifest.json",
  );
  const prepared = await verifyPreparedManifest(manifestPath);
  const record = prepared.package;
  const decision = decidePublication(
    record.integrity,
    queryRegistryIntegrity(record.name, record.version),
  );
  const state = decision === "skip" ? "exact" : "absent";
  process.stdout.write(`${record.name}@${record.version}: ${state}\n`);
  return [{ name: record.name, state }];
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) fail(`could not parse npm version ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function confirmRegistryIntegrity(record) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const integrity = queryRegistryIntegrity(record.name, record.version);
    if (integrity !== null && safeEqual(record.integrity, integrity)) return;
    if (attempt < 5) wait(2 ** attempt * 1000);
  }
  fail(
    `${record.name}@${record.version} did not expose the prepared integrity`,
  );
}

export async function publishPreparedRelease(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release:publish is restricted to a GitHub release workflow");
  }
  if (process.env.NODE_AUTH_TOKEN !== undefined) {
    fail("release:publish refuses npm token authentication");
  }
  requireTrustedPublishingNpm();
  const manifestPath = resolve(
    options.manifest ?? ".release/package-manifest.json",
  );
  const prepared = await verifyPreparedManifest(manifestPath);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (
    releaseTag !== `v${prepared.version}` ||
    prepared.releaseTag !== releaseTag
  ) {
    fail("prepared manifest must match the stable release tag");
  }
  if (
    expectedCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedCommit) ||
    !safeEqual(expectedCommit, prepared.gitCommit)
  ) {
    fail("prepared package manifest must match the release event commit");
  }

  const record = prepared.package;
  const decision = decidePublication(
    record.integrity,
    queryRegistryIntegrity(record.name, record.version),
  );
  if (decision === "skip") {
    process.stdout.write(
      `Verified existing ${record.name}@${record.version}; skipping.\n`,
    );
    return;
  }
  runNpm(
    [
      "publish",
      resolve(dirname(manifestPath), record.tarball),
      "--access",
      "public",
      "--provenance",
    ],
    { cwd: dirname(manifestPath) },
  );
  confirmRegistryIntegrity(record);
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--expected-release-commit"
              ? "expectedReleaseCommit"
              : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    const { version } = await validateRepository(options);
    process.stdout.write(`Release metadata is valid for ${version}.\n`);
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release package at ${manifestPath}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  if (command === "registry-check") {
    await inspectPreparedRegistry(options);
    return;
  }
  fail(
    "usage: release-packages.mjs <check|pack|publish|registry-check> [options]",
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

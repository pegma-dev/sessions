import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  createIsolatedNpmRuntime,
  decidePublication,
  isSupportedReleaseTag,
  isolatedNpmEnvironment,
  parseArguments,
  parsePnpmLockImporters,
  prepareRelease,
  resolvedVersionSatisfies,
  runNpm,
  validateLockImporter,
  validateReleaseInventory,
  validateReleaseTag,
  validateRepository,
} from "../scripts/release-packages.mjs";

const git = process.platform === "win32" ? "git.exe" : "git";
const packageVersion = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "packages", "sessions", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

function run(command: string, arguments_: string[], cwd?: string): string {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function workflowRunScripts(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/u);
  const scripts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/u.exec(lines[index] ?? "");
    if (match === null) continue;
    const runValue = match[2] ?? "";
    if (!/^[|>][+-]?$/u.test(runValue)) {
      scripts.push(runValue);
      continue;
    }
    const indentation = (match[1] ?? "").length;
    const block: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lineIndentation = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (line !== "" && lineIndentation <= indentation) {
        index -= 1;
        break;
      }
      block.push(line);
    }
    scripts.push(block.join("\n"));
  }
  return scripts;
}

describe("release package metadata", () => {
  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("keeps the exact public package inventory", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual([
      "@pegma/sessions",
    ]);
  });

  it("validates the root, package manifest, and lockfile together", async () => {
    await expect(validateRepository()).resolves.toMatchObject({
      version: packageVersion,
    });
  });

  it("resolves npm beside Node and does not use a package-manager wrapper", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "release-packages.mjs"),
      "utf8",
    );
    expect(source).not.toContain("process.env.npm_execpath");
    expect(source).toContain('"npm", "bin", "npm-cli.js"');
    expect(source).toContain("command: process.execPath");
    expect(source).toContain("shell: false");
    expect(source).toContain('runNpm(["--prefix", root, "run", "build"]);');
    expect(runNpm(["--version"], { capture: true }).stdout.trim()).toMatch(
      /^\d+\.\d+\.\d+(?:-.+)?$/u,
    );
  });

  it("uses private npm configuration and an allowlisted environment", () => {
    const source = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      CI: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "pegma-dev/sessions",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/id-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      npm_config_registry: "https://example.test/registry",
      NPM_CONFIG_CACHE: "cache",
      NPM_TOKEN: "package-token",
      NODE_AUTH_TOKEN: "node-token",
      NODE_OPTIONS: "--inspect",
      NODE_EXTRA_CA_CERTS: "ca.pem",
      HTTPS_PROXY: "https://example.test/proxy",
    };
    const env = isolatedNpmEnvironment(source, "user-config", "global-config");
    expect(env).toMatchObject({
      CI: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "pegma-dev/sessions",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/id-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      NPM_CONFIG_USERCONFIG: "user-config",
      NPM_CONFIG_GLOBALCONFIG: "global-config",
    });
    for (const name of [
      "npm_config_registry",
      "NPM_CONFIG_CACHE",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "HTTPS_PROXY",
    ]) {
      expect(env).not.toHaveProperty(name);
    }

    const runtime = createIsolatedNpmRuntime(source);
    try {
      expect(readdirSync(runtime.cwd)).toEqual([]);
      if (process.platform !== "win32") {
        expect(statSync(runtime.userConfig).mode & 0o777).toBe(0o600);
        expect(statSync(runtime.globalConfig).mode & 0o777).toBe(0o600);
      }
      expect(readFileSync(runtime.userConfig, "utf8")).toBe("");
      expect(readFileSync(runtime.globalConfig, "utf8")).toBe("");
      expect(runtime.command).toBe(process.execPath);
      expect(runtime.argumentsPrefix[0]).toMatch(/npm-cli\.js$/u);
    } finally {
      runtime.cleanup();
    }
  });

  it("matches each lockfile dependency to its own specifier and resolved version", () => {
    const lock = parsePnpmLockImporters(
      readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8"),
    );
    const rootManifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const packageManifest = JSON.parse(
      readFileSync(
        join(process.cwd(), "packages", "sessions", "package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };

    expect(lock.lockfileVersion).toBe("9.0");
    expect(lock.importers["."]?.devDependencies?.prettier).toEqual({
      specifier: rootManifest.devDependencies.prettier,
      version: "3.9.6",
    });
    expect(
      lock.importers["packages/sessions"]?.dependencies?.["@pegma/spine"],
    ).toEqual({
      specifier: packageManifest.dependencies["@pegma/spine"],
      version: "0.1.1",
    });
    expect(
      lock.importers["packages/sessions"]?.dependencies?.[
        "@pegma/storage-core"
      ],
    ).toEqual({
      specifier: packageManifest.dependencies["@pegma/storage-core"],
      version: "0.4.0",
    });

    expect(() =>
      validateLockImporter(lock.importers["."], rootManifest, "root"),
    ).not.toThrow();
    expect(() =>
      validateLockImporter(
        lock.importers["packages/sessions"],
        packageManifest,
        "package",
      ),
    ).not.toThrow();
    expect(() =>
      validateLockImporter(
        {
          dependencies: {
            "@pegma/spine": { specifier: "0.4.0", version: "0.1.1" },
            "@pegma/storage-core": { specifier: "0.1.1", version: "0.4.0" },
          },
        },
        packageManifest,
        "swapped",
      ),
    ).toThrow("must match its own specifier and resolved version");
  });

  it("unquotes YAML scalars before comparing lockfile specifier and version", () => {
    const lock = parsePnpmLockImporters(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      foo:
        specifier: '1'
        version: '1.0.0'
      bar:
        specifier: '*'
        version: 2.0.0
      baz:
        specifier: '1.0.0'
        version: '1.0.0'
`);
    expect(lock.importers["."]?.dependencies?.foo).toEqual({
      specifier: "1",
      version: "1.0.0",
    });
    expect(lock.importers["."]?.dependencies?.bar).toEqual({
      specifier: "*",
      version: "2.0.0",
    });
    expect(lock.importers["."]?.dependencies?.baz).toEqual({
      specifier: "1.0.0",
      version: "1.0.0",
    });
    expect(() =>
      validateLockImporter(
        {
          dependencies: {
            bar: { specifier: "*", version: "2.0.0" },
            baz: { specifier: "1.0.0", version: "1.0.0" },
          },
        },
        { dependencies: { bar: "*", baz: "1.0.0" } },
        "quoted",
      ),
    ).not.toThrow();
  });

  it("accepts resolved versions that satisfy the declared specifier range", () => {
    expect(resolvedVersionSatisfies("1.2.3", "^1.2.0")).toBe(true);
    expect(
      resolvedVersionSatisfies("1.2.3(@types/node@24.0.0)", "^1.2.0"),
    ).toBe(true);
    expect(resolvedVersionSatisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(resolvedVersionSatisfies("3.9.6", "^3.9.6")).toBe(true);
    expect(resolvedVersionSatisfies("1.2.0", "1.2.0")).toBe(true);
    expect(resolvedVersionSatisfies("1.2.3", "*")).toBe(true);
    expect(resolvedVersionSatisfies("1.2.3", "1.2.0")).toBe(false);
    expect(resolvedVersionSatisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(resolvedVersionSatisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(resolvedVersionSatisfies("1.2.3", ">=1.2.0")).toBe(false);
    expect(() =>
      validateLockImporter(
        {
          devDependencies: {
            prettier: { specifier: "^3.9.6", version: "3.9.6" },
          },
        },
        { devDependencies: { prettier: "^3.9.6" } },
        "range",
      ),
    ).not.toThrow();
    expect(() =>
      validateLockImporter(
        {
          dependencies: {
            "@pegma/spine": { specifier: "0.1.1", version: "0.1.2" },
          },
        },
        { dependencies: { "@pegma/spine": "0.1.1" } },
        "exact-mismatch",
      ),
    ).toThrow("must match its own specifier and resolved version");
  });

  it("includes peerDependencies in lockfile validation", () => {
    expect(() =>
      validateLockImporter(
        {
          peerDependencies: {
            typescript: { specifier: "^5.0.0", version: "5.9.3" },
          },
        },
        { peerDependencies: { typescript: "^5.0.0" } },
        "peers",
      ),
    ).not.toThrow();
    expect(() =>
      validateLockImporter(
        {},
        { peerDependencies: { typescript: "^5.0.0" } },
        "missing-peer",
      ),
    ).toThrow("must match its own specifier and resolved version");
    expect(() =>
      validateLockImporter(
        {
          peerDependencies: {
            typescript: { specifier: "^4.0.0", version: "4.9.5" },
          },
        },
        { peerDependencies: { typescript: "^5.0.0" } },
        "stale-peer",
      ),
    ).toThrow("must match its own specifier and resolved version");
    expect(() =>
      validateLockImporter(
        {
          peerDependencies: {
            a: { specifier: "^2.0.0", version: "2.0.0" },
            b: { specifier: "^1.0.0", version: "1.0.0" },
          },
        },
        { peerDependencies: { a: "^1.0.0", b: "^2.0.0" } },
        "swapped-peer",
      ),
    ).toThrow("must match its own specifier and resolved version");
  });

  it("requires the release tag to match the package version", async () => {
    await expect(validateRepository({ releaseTag: "v9.9.9" })).rejects.toThrow(
      `release tag must be v${packageVersion}`,
    );
    await expect(
      validateRepository({
        releaseTag: `v${packageVersion}`,
        releasePrerelease: true,
      }),
    ).rejects.toThrow("prereleases cannot publish packages");
  });

  it("accepts only stable release tags at or above the supported floor", () => {
    expect(isSupportedReleaseTag("v0.1.1")).toBe(true);
    expect(isSupportedReleaseTag("v0.12.0")).toBe(true);
    expect(isSupportedReleaseTag("v1.0.0")).toBe(true);
    expect(isSupportedReleaseTag("v0.1.0")).toBe(false);
    expect(isSupportedReleaseTag("v0.0.9")).toBe(false);
    expect(isSupportedReleaseTag("v01.2.3")).toBe(false);
    expect(isSupportedReleaseTag("v1.01.0")).toBe(false);
    expect(isSupportedReleaseTag("v0.1.01")).toBe(false);
    expect(isSupportedReleaseTag("v1.2.3-beta.1")).toBe(false);
  });

  it("requires an exact regular-file release inventory", async () => {
    const root = mkdtempSync(join(tmpdir(), "sessions-release-inventory-"));
    const directory = join(root, "release");
    const tarball = "pegma-sessions-0.1.1.tgz";
    try {
      mkdirSync(directory);
      writeFileSync(join(directory, "package-manifest.json"), "{}\n");
      writeFileSync(join(directory, tarball), "package bytes");
      await expect(
        validateReleaseInventory(directory, tarball),
      ).resolves.toEqual({ tarball });

      writeFileSync(join(directory, ".extra"), "extra");
      await expect(
        validateReleaseInventory(directory, tarball),
      ).rejects.toThrow("only the manifest and package tarball");
      rmSync(join(directory, ".extra"));

      rmSync(join(directory, tarball));
      mkdirSync(join(directory, tarball));
      await expect(
        validateReleaseInventory(directory, tarball),
      ).rejects.toThrow("regular files");
      rmSync(join(directory, tarball), { recursive: true });

      if (process.platform !== "win32") {
        const target = join(root, "target.tgz");
        writeFileSync(target, "package bytes");
        symlinkSync(target, join(directory, tarball), "file");
        await expect(
          validateReleaseInventory(directory, tarball),
        ).rejects.toThrow("regular files");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes generated outputs before building and records both digests", async () => {
    const packageDirectory = join(process.cwd(), "packages", "sessions");
    const dist = join(packageDirectory, "dist");
    const buildInfo = join(packageDirectory, "tsconfig.tsbuildinfo");
    const rootBuildInfo = join(process.cwd(), "tsconfig.tsbuildinfo");
    const root = mkdtempSync(join(tmpdir(), "sessions-release-pack-"));
    const output = join(root, "release");
    try {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "stale.js"), "stale output\n");
      writeFileSync(buildInfo, "stale build information\n");
      writeFileSync(rootBuildInfo, "stale root build information\n");
      const result = await prepareRelease({
        output,
        smokeTest: async () => undefined,
      });
      const prepared = result.manifest as {
        package: { integrity: string; sha256: string; tarball: string };
      };
      expect(() => statSync(join(dist, "stale.js"))).toThrow();
      expect(() => statSync(rootBuildInfo)).toThrow();
      expect(prepared.package.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(prepared.package.integrity).toMatch(
        /^sha512-[A-Za-z0-9+/]{86}==$/u,
      );
      await expect(
        validateReleaseInventory(output, prepared.package.tarball),
      ).resolves.toEqual({ tarball: prepared.package.tarball });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dist, { recursive: true, force: true });
      rmSync(buildInfo, { force: true });
      rmSync(rootBuildInfo, { force: true });
    }
  }, 120_000);
});

describe("release source authentication", () => {
  it("accepts only an approved signed annotated tag at the event commit", () => {
    const root = mkdtempSync(join(tmpdir(), "sessions-release-tag-"));
    try {
      run(git, ["init", "--quiet"], root);
      run(git, ["config", "user.name", "Release Test"], root);
      run(git, ["config", "user.email", "release@example.com"], root);
      writeFileSync(join(root, "README.md"), "release test\n");
      run(git, ["add", "README.md"], root);
      run(git, ["commit", "--quiet", "-m", "release"], root);
      run(git, ["branch", "-M", "main"], root);
      run(git, ["update-ref", "refs/remotes/origin/main", "HEAD"], root);
      const releaseCommit = run(git, ["rev-parse", "HEAD"], root);

      const signingKey = join(root, "release-signing-key");
      run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "release@example.com",
        "-f",
        signingKey,
      ]);
      const allowedSigners = join(root, "allowed-signers");
      writeFileSync(
        allowedSigners,
        `release@example.com ${readFileSync(`${signingKey}.pub`, "utf8").trim()}\n`,
      );
      run(git, ["config", "gpg.format", "ssh"], root);
      run(git, ["config", "user.signingkey", signingKey], root);
      run(git, ["config", "gpg.ssh.allowedSignersFile", allowedSigners], root);

      run(git, ["tag", "--sign", "v0.1.1", "--message", "signed"], root);
      expect(
        validateReleaseTag({
          root,
          releaseTag: "v0.1.1",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toEqual({ headCommit: releaseCommit, releaseTag: "v0.1.1" });

      run(git, ["tag", "v0.1.2"], root);
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.1.2",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("annotated tag object");

      run(
        git,
        [
          "-c",
          "commit.gpgsign=false",
          "tag",
          "--annotate",
          "v0.1.3",
          "--message",
          "unsigned",
        ],
        root,
      );
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.1.3",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("not valid for an approved signer");

      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.1.0",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("stable release tag");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifies the release source before preparation and isolates publication", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const header = workflow.slice(0, jobsIndex);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const publishStart = jobs.indexOf("\n  publish:");
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(prepareStart);
    const prepare = jobs.slice(prepareStart, publishStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).not.toContain("id-token: write");
    expect(publish).toContain("environment: npm-publish");
    expect(publish).toContain("id-token: write");

    const prepareVerify = prepare.indexOf("- name: Verify the release source");
    const prepareCheckout = prepare.indexOf("uses: actions/checkout@");
    expect(prepareVerify).toBeGreaterThanOrEqual(0);
    expect(prepareCheckout).toBeGreaterThan(prepareVerify);
    expect(prepare.slice(0, prepareCheckout)).toContain(
      "git init --quiet --bare",
    );
    expect(prepare.slice(0, prepareCheckout)).toContain(
      'git -C "${repository}" verify-tag "${tag_ref}"',
    );
    expect(prepare.slice(0, prepareCheckout)).toContain(
      "merge-base --is-ancestor",
    );
    expect(prepare.slice(0, prepareCheckout)).toContain(
      "::error::Release ref must be an annotated tag",
    );
    expect(prepare).toContain("ref: ${{ github.sha }}");
    expect(prepare).toContain("persist-credentials: false");
    expect(prepare).toContain("pnpm run release:check");
    expect(prepare).toContain("rm -rf -- packages/sessions/dist");
    expect(prepare).toContain("-type f -name '*.tsbuildinfo' -delete");
    expect(prepare).toContain("include-hidden-files: false");
    expect(prepare).toContain("release-upload/package-manifest.json");
    expect(prepare).toContain(
      "tarball=release-upload/pegma-sessions-${version}.tgz",
    );
    expect(prepare).toContain("steps.inventory.outputs.tarball");

    expect(publish).not.toContain("actions/checkout@");
    const publishSteps = publish.indexOf("\n    steps:");
    expect(publishSteps).toBeGreaterThanOrEqual(0);
    expect(publish.slice(0, publishSteps)).not.toContain("${{ runner.");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("release:pack");
    expect(publish).not.toContain("scripts/release-packages.mjs");
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("pnpm run");
    expect(publish).toContain("git init --quiet --bare");
    expect(publish).toContain('git -C "${repository}" verify-tag');
    expect(publish).toContain("merge-base --is-ancestor");
    expect(publish).toContain(
      'const expectedNames = ["package-manifest.json", expectedTarball]',
    );
    expect(publish).toContain("entry?.isFile() !== true");
    expect(publish).toContain("record.sha256");
    expect(publish).toContain("record.integrity");
    expect(publish).toContain('"dist/index.d.ts"');
    expect(publish).toContain('"dist/index.js"');
    expect(publish).toContain("NPM_CONFIG_USERCONFIG");
    expect(publish).toContain("NPM_CONFIG_GLOBALCONFIG");
    expect(publish).toContain(
      "RELEASE_DIRECTORY: ${{ runner.temp }}/sessions-release/.release",
    );
    expect(publish).toContain('"--provenance"');
    expect(publish).toContain('"--ignore-scripts"');
    expect(publish).toContain('"--registry"');
    expect(publish).toContain("spawnSync(process.execPath");
    expect(publish).toContain("for (let attempt = 0; attempt < 6");
    expect(publish).toContain("did not expose the prepared package integrity");
    expect(prepare).toContain('npm install --global "${npm_tarball}"');
    expect(publish).toContain('npm install --global "${npm_tarball}"');
    expect(
      workflow.match(/npm-11\.18\.0\.tgz/gu)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      workflow.match(
        /sha512-T67M4L5wNm0cZ7EBLErcEkY1SmzEW\/WJ\+SADBzsFUY1UdAPfFHXFQtZ6SEXiK0\+vzXysCvAsepbMaBTwnrAD\+w==/gu,
      ),
    ).toHaveLength(2);
    for (const name of [
      "COMSPEC",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOCALAPPDATA",
      "PATHEXT",
      "USERPROFILE",
      "WINDIR",
    ]) {
      expect(publish).toContain(`"${name}"`);
    }
    expect(workflow.match(/git init --quiet --bare/gu)).toHaveLength(2);
    const verificationScripts = workflowRunScripts(workflow).filter((script) =>
      script.includes("release-verify.XXXXXX"),
    );
    expect(verificationScripts).toHaveLength(2);
    expect(verificationScripts[1]).toBe(verificationScripts[0]);
    expect(
      workflow.match(
        /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/gu,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /RELEASE_PRERELEASE: \$\{\{ github\.event\.release\.prerelease \}\}/gu,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(/RELEASE_COMMIT: \$\{\{ github\.sha \}\}/gu),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /RELEASE_ALLOWED_SIGNERS: \$\{\{ vars\.RELEASE_ALLOWED_SIGNERS \}\}/gu,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(/\[\[ "\$\{RELEASE_TAG\}" == "v0\.1\.0" \]\]/gu),
    ).toHaveLength(2);
    expect(workflowRunScripts('run: >-\n  echo "${{ value }}"')).toEqual([
      '  echo "${{ value }}"',
    ]);
    for (const script of workflowRunScripts(workflow)) {
      expect(script).not.toContain("${{");
    }
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("retention-days: 30");
  });

  it("installs pnpm before setup-node caches the pnpm store", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const setupPnpm = workflow.indexOf("pnpm/action-setup@");
    const cachePnpm = workflow.indexOf("cache: pnpm");
    expect(setupPnpm).toBeGreaterThanOrEqual(0);
    expect(cachePnpm).toBeGreaterThan(setupPnpm);
    expect(workflow).toContain(
      "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
    );
    expect(workflow).toContain("pnpm run release:check");
  });
});

describe("retry-safe publication", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-ZGlmZmVyZW50")).toThrow(
      "different tarball integrity",
    );
  });
});

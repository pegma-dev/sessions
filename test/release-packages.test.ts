import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  decidePublication,
  parseArguments,
  parsePnpmLockImporters,
  validateLockImporter,
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

  it("never routes pack, view, or publish through npm_execpath", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "release-packages.mjs"),
      "utf8",
    );
    expect(source).not.toContain("process.env.npm_execpath");
    expect(source).toContain(
      'process.platform === "win32" ? "npm.cmd" : "npm"',
    );
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

      run(git, ["tag", "--sign", "v0.0.0", "--message", "signed"], root);
      expect(
        validateReleaseTag({
          root,
          releaseTag: "v0.0.0",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toEqual({ headCommit: releaseCommit, releaseTag: "v0.0.0" });

      run(git, ["tag", "v0.0.1"], root);
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.0.1",
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
          "v0.0.2",
          "--message",
          "unsigned",
        ],
        root,
      );
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.0.2",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("not valid for an approved signer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps broad preparation outside the OIDC-enabled publisher job", () => {
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
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm install");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("release:pack");
    expect(publish).toContain("node scripts/release-packages.mjs publish");
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("pnpm run");
    expect(prepare).toContain("npm install --global npm@11.18.0");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
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

export interface ReleasePackageDefinition {
  readonly directory: string;
  readonly name: string;
}

export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
}

export interface ReleaseCommandOptions extends ValidationOptions {
  readonly manifest?: string;
  readonly output?: string;
}

export interface PublicPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export interface ValidationResult {
  readonly root: string;
  readonly version: string;
  readonly manifest: PublicPackageManifest;
  readonly packageDirectory: string;
  readonly releaseTag: string | undefined;
}

export interface RegistryState {
  readonly name: string;
  readonly state: "absent" | "exact";
}

export interface LockDependencyEntry {
  readonly specifier: string | undefined;
  readonly version: string | undefined;
}

export interface LockImporter {
  readonly [section: string]:
    Readonly<Record<string, LockDependencyEntry>> | undefined;
}

export interface ParsedPnpmLock {
  readonly lockfileVersion: string | undefined;
  readonly importers: Readonly<Record<string, LockImporter>>;
}

export const RELEASE_PACKAGES: readonly ReleasePackageDefinition[];

export function parseArguments(
  arguments_: readonly string[],
): ReleaseCommandOptions;

export function validateRepository(
  options?: ValidationOptions,
): Promise<ValidationResult>;

export function validateReleaseTag(options?: {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly expectedReleaseCommit?: string;
}): { headCommit: string; releaseTag: string };

export function decidePublication(
  localIntegrity: string,
  registryIntegrity: string | null,
): "publish" | "skip";

export function parsePnpmLockImporters(text: string): ParsedPnpmLock;

export function resolvedVersionSatisfies(
  version: string,
  specifier: string,
): boolean;

export function validateLockImporter(
  importer: LockImporter | undefined,
  manifest: Record<string, unknown>,
  location: string,
): void;

export function prepareRelease(
  options?: ReleaseCommandOptions,
): Promise<{ manifestPath: string; manifest: unknown }>;

export function inspectPreparedRegistry(
  options?: ReleaseCommandOptions,
): Promise<RegistryState[]>;

export function publishPreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;

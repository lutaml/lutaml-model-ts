import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Checksum, Manifest, SchemaFormat } from "../contracts.js";
import { bundleChecksum } from "./canonical.js";
import { fail } from "./errors.js";
import { canonicalManifestJson, sha256Of } from "../artifacts/index.js";
import type { Plain } from "../artifacts/index.js";
import { loadBundle, loadManifest } from "./index.js";
import { compareBytes } from "./validator.js";

/** Files of an artifact directory that are not listed in manifest.json. */
export const MANIFEST_FILES: readonly string[] = ["manifest.json", "manifest.sha256"];

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Digest of the canonical manifest, as the consumer pins it. */
export function manifestChecksum(manifest: Manifest): Checksum {
  return sha256Of(canonicalManifestJson(manifest as unknown as Plain));
}

/** Throws `checksum_mismatch` unless the bundle's canonical checksum equals `expected`. */
export function verifyBundleChecksum(bytes: Uint8Array, format: SchemaFormat, expected: string): Checksum {
  const actual = bundleChecksum(loadBundle(bytes, format));
  if (!DIGEST.test(expected) || actual !== expected) {
    fail("checksum_mismatch", `bundle checksum ${actual} does not equal pinned ${expected}`, "/bundle");
  }
  return actual;
}

export interface VerifyArtifactsOptions {
  readonly root: string;
  /** Manifest bytes (manifest.json). Defaults to reading `<root>/manifest.json`. */
  readonly manifestBytes?: Uint8Array;
  /** The caller's pin of the whole canonical manifest. */
  readonly expectedSha256: string;
  /** Optional pins; each must equal the manifest's value when given. */
  readonly lmlChecksum?: string;
  readonly generatorVersion?: string;
  readonly corpora?: Manifest["corpora"];
  readonly dependencies?: Manifest["dependencies"];
}

export interface ArtifactListing {
  /** Regular files. */
  files: string[];
  symlinks: string[];
  /** FIFOs, sockets and devices: never read, never accepted. */
  special: string[];
  /** Directories with no entries, as "dir/". */
  emptyDirs: string[];
}

/** Runs a filesystem call; an errno failure (EACCES, EISDIR, ...) surfaces as an LmlError, not a raw Node error. */
export function ioGuard<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") fail("invalid_document", `cannot read ${path}: ${code}`, "");
    throw error;
  }
}

/** Every entry under `root` as "/"-joined relative paths; symlinks are reported, never followed, and nothing but regular files is ever read. */
export function listArtifactFiles(root: string): ArtifactListing {
  const out: ArtifactListing = { files: [], symlinks: [], special: [], emptyDirs: [] };
  const walk = (dir: string, prefix: string): void => {
    const names = ioGuard(dir, () => readdirSync(dir));
    if (names.length === 0 && prefix !== "") out.emptyDirs.push(`${prefix}/`);
    for (const name of names) {
      const path = join(dir, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const stat = ioGuard(path, () => lstatSync(path));
      if (stat.isSymbolicLink()) out.symlinks.push(relative);
      else if (stat.isDirectory()) walk(path, relative);
      else if (stat.isFile()) out.files.push(relative);
      else out.special.push(relative);
    }
  };
  walk(root, "");
  for (const key of Object.keys(out) as (keyof ArtifactListing)[]) out[key].sort(compareBytes);
  return out;
}

/** Paths in a listing that the manifest and the generated set do not account for. */
export function unlistedEntries(listing: ArtifactListing, accounted: (path: string) => boolean): string[] {
  return [...listing.files, ...listing.symlinks, ...listing.special, ...listing.emptyDirs]
    // manifest.* is exempt only as a regular file; a symlink or special entry of that name is reported.
    .filter((p) => !accounted(p) && !(MANIFEST_FILES.includes(p) && listing.files.includes(p)))
    .sort(compareBytes);
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalManifestJson(a as Plain) === canonicalManifestJson(b as Plain);
}

/**
 * Verifies an artifact directory against a caller-pinned manifest digest:
 * manifest checksum, optional pins, every listed file's digest (case-exact
 * paths, no traversal, no symlinks), and no file the manifest does not list.
 * Throws LmlError (`checksum_mismatch`, `invalid_document`, `unsupported_version`).
 */
export function verifyArtifacts(options: VerifyArtifactsOptions): Manifest {
  const root = ioGuard(options.root, () => realpathSync(options.root));
  const listing = listArtifactFiles(root);
  const { files: onDisk, symlinks, special } = listing;
  // The two manifest files get the same file-kind check as every listed file, before anything is read.
  for (const name of MANIFEST_FILES) {
    if (symlinks.includes(name)) fail("invalid_document", `${name} is a symlink`, `/${name}`);
    if (special.includes(name)) fail("invalid_document", `${name} is not a regular file`, `/${name}`);
  }
  if (options.manifestBytes === undefined && !onDisk.includes("manifest.json")) {
    fail("invalid_document", "manifest.json is not a regular file in the artifact directory", "/manifest.json");
  }
  const manifestBytes = options.manifestBytes ?? ioGuard("manifest.json", () => readFileSync(join(root, "manifest.json")));
  const manifest = loadManifest(manifestBytes, "json");
  if (!DIGEST.test(options.expectedSha256) || manifestChecksum(manifest) !== options.expectedSha256) {
    fail("checksum_mismatch", "manifest digest does not equal the pinned digest", "/manifest");
  }
  const pins: [string, unknown, unknown][] = [
    ["lml_checksum", options.lmlChecksum, manifest.lml_checksum],
    ["generator_version", options.generatorVersion, manifest.generator_version],
    ["corpora", options.corpora, manifest.corpora],
    ["dependencies", options.dependencies, manifest.dependencies],
  ];
  for (const [key, expected, actual] of pins) {
    if (expected !== undefined && !sameJson(expected, actual)) {
      fail("checksum_mismatch", `${key} does not equal the pinned value`, `/${key}`);
    }
  }
  if (manifest.files.length === 0) fail("invalid_document", "manifest lists no files", "/files");

  const listed = new Set<string>(manifest.files.map((f) => f.path));
  manifest.files.forEach((record, index) => {
    const location = `/files/${index}/path`;
    if (symlinks.some((s) => s === record.path || record.path.startsWith(`${s}/`))) {
      fail("invalid_document", `${record.path} is or passes through a symlink`, location);
    }
    if (special.includes(record.path)) fail("invalid_document", `${record.path} is not a regular file`, location);
    // Case-exact: the path must be among the names actually on disk, not merely resolvable.
    if (!onDisk.includes(record.path)) fail("invalid_document", `${record.path} is not a file in the artifact directory`, location);
    const path = join(root, ...record.path.split("/"));
    const real = ioGuard(path, () => realpathSync(path));
    if (!real.startsWith(root + sep)) fail("invalid_document", `${record.path} resolves outside the artifact directory`, location);
    if (sha256Of(ioGuard(path, () => readFileSync(path))) !== record.sha256) {
      fail("checksum_mismatch", `${record.path} does not match its recorded digest`, `/files/${index}/sha256`);
    }
  });
  const extra = unlistedEntries(listing, (p) => listed.has(p));
  if (extra.length > 0) {
    fail("invalid_document", `files not listed in the manifest: ${extra.join(", ")}`, "/files");
  }
  if (onDisk.includes("manifest.sha256")) {
    const text = ioGuard("manifest.sha256", () => readFileSync(join(root, "manifest.sha256"), "utf8")).trim();
    if (text !== options.expectedSha256) fail("checksum_mismatch", "manifest.sha256 does not equal the pinned digest", "/manifest.sha256");
  }
  return manifest;
}

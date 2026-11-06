import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Checksum, Manifest, SchemaFormat } from "../contracts.js";
import { bundleChecksum } from "./canonical.js";
import { fail } from "./errors.js";
import { loadBundle, loadManifest } from "./index.js";
import { compareBytes } from "./validator.js";

/** Files of an artifact directory that are not listed in manifest.json. */
export const MANIFEST_FILES: readonly string[] = ["manifest.json", "manifest.sha256"];

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const digestOf = (data: string | Uint8Array): Checksum =>
  `sha256:${createHash("sha256").update(data).digest("hex")}` as Checksum;

type Plain = string | number | boolean | null | readonly Plain[] | { readonly [key: string]: Plain };

/** Compact JSON with sorted keys: the Ruby verifier's `JSON.generate(canonical(value))`. */
function canonicalJson(value: Plain): string {
  const sorted = (v: Plain): Plain => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === "object") {
      const out: { [key: string]: Plain } = {};
      for (const key of Object.keys(v).sort(compareBytes)) out[key] = sorted((v as { [k: string]: Plain })[key] as Plain);
      return out;
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

/** Digest of the canonical manifest, as the consumer pins it. */
export function manifestChecksum(manifest: Manifest): Checksum {
  return digestOf(canonicalJson(manifest as unknown as Plain));
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

/** Every regular file under `root` as a "/"-joined relative path; symlinks are reported, never followed. */
export function listArtifactFiles(root: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) symlinks.push(relative);
      else if (stat.isDirectory()) walk(path, relative);
      else files.push(relative);
    }
  };
  walk(root, "");
  return { files: files.sort(compareBytes), symlinks: symlinks.sort(compareBytes) };
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a as Plain) === canonicalJson(b as Plain);
}

/**
 * Verifies an artifact directory against a caller-pinned manifest digest:
 * manifest checksum, optional pins, every listed file's digest (case-exact
 * paths, no traversal, no symlinks), and no file the manifest does not list.
 * Throws LmlError (`checksum_mismatch`, `invalid_document`, `unsupported_version`).
 */
export function verifyArtifacts(options: VerifyArtifactsOptions): Manifest {
  const root = realpathSync(options.root);
  const manifestBytes = options.manifestBytes ?? readFileSync(join(root, "manifest.json"));
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

  const { files: onDisk, symlinks } = listArtifactFiles(root);
  const listed = new Set<string>(manifest.files.map((f) => f.path));
  manifest.files.forEach((record, index) => {
    const location = `/files/${index}/path`;
    if (symlinks.some((s) => s === record.path || record.path.startsWith(`${s}/`))) {
      fail("invalid_document", `${record.path} is or passes through a symlink`, location);
    }
    // Case-exact: the path must be among the names actually on disk, not merely resolvable.
    if (!onDisk.includes(record.path)) fail("invalid_document", `${record.path} is not a file in the artifact directory`, location);
    const path = join(root, ...record.path.split("/"));
    const real = realpathSync(path);
    if (!real.startsWith(root + sep)) fail("invalid_document", `${record.path} resolves outside the artifact directory`, location);
    if (digestOf(readFileSync(path)) !== record.sha256) {
      fail("checksum_mismatch", `${record.path} does not match its recorded digest`, `/files/${index}/sha256`);
    }
  });
  const extra = [...onDisk.filter((p) => !listed.has(p) && !MANIFEST_FILES.includes(p)), ...symlinks.filter((p) => !listed.has(p))];
  if (extra.length > 0) {
    fail("invalid_document", `files not listed in the manifest: ${extra.join(", ")}`, "/files");
  }
  if (onDisk.includes("manifest.sha256")) {
    const text = readFileSync(join(root, "manifest.sha256"), "utf8").trim();
    if (text !== options.expectedSha256) fail("checksum_mismatch", "manifest.sha256 does not equal the pinned digest", "/manifest.sha256");
  }
  return manifest;
}

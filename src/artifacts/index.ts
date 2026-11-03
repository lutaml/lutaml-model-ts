import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LmlError, MANIFEST_VERSION, LML_DOCUMENT_VERSION } from "../contracts.js";
import type { Bindings, Bundle, Checksum, Manifest, SchemaFormat, SourceMap } from "../contracts.js";
import { createKeyValueEmitter } from "../codecs/index.js";
import type { KeyValueFormat } from "../codecs/index.js";
import { generateModelsWith } from "../generator/index.js";
import { bundleChecksum, loadBundle } from "../lml/index.js";
import { compareBytes } from "../lml/validator.js";

export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_DIGEST_FILE = "manifest.sha256";

export interface ArtifactInput {
  readonly bundleBytes: Uint8Array;
  readonly bundleFormat: SchemaFormat;
  readonly bindings: Bindings;
  /** Key-value codec families to emit; defaults to ["json"]. */
  readonly formats?: readonly KeyValueFormat[];
  /** Module the generated runtime imports `lutaml-model-ts` types from. */
  readonly contractsModule?: string;
  /** Override the recorded generator version (defaults to this package's). */
  readonly generatorVersion?: string;
}

export interface ArtifactSet {
  /** Generated sources plus manifest.json and manifest.sha256, path -> text. */
  readonly files: SourceMap;
  readonly manifest: Manifest;
  /** Canonical manifest bytes as written to manifest.json. */
  readonly manifestJson: string;
  /** External digest of the whole canonical manifest (the consumer pins this). */
  readonly manifestSha256: Checksum;
}

/** Digest of exact bytes, `sha256:<hex>`. */
export function sha256Of(data: string | Uint8Array): Checksum {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

type Plain = string | number | boolean | null | readonly Plain[] | { readonly [key: string]: Plain };

/**
 * Compact JSON with recursively sorted keys: byte-identical to the Ruby
 * verifier's `JSON.generate(canonical(value))` for the manifest's value space
 * (strings, integers, arrays, objects).
 */
export function canonicalManifestJson(value: Plain): string {
  const sorted = (v: Plain): Plain => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === "object") {
      const out: { [key: string]: Plain } = {};
      for (const key of Object.keys(v).sort(compareBytes)) out[key] = sorted((v as { [k: string]: Plain })[key] as Plain);
      return out;
    }
    if (typeof v === "number" && !Number.isInteger(v)) {
      throw new LmlError({ reason: "invalid_document", detail: "manifest holds only integers" });
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

let cachedVersion: string | undefined;
/** `lutaml-model-ts` package version, read from package.json (works from src/ and dist/). */
export function packageVersion(): string {
  if (cachedVersion === undefined) {
    const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    cachedVersion = (JSON.parse(text) as { version: string }).version;
  }
  return cachedVersion;
}

function dependencyPins(bindings: Bindings, version: string): Manifest["dependencies"] {
  const pins = new Map<string, { revision: string; sha256: Checksum }>();
  // The generated code imports lutaml-model-ts; pin the declared name@version.
  pins.set("lutaml-model-ts", {
    revision: version,
    sha256: sha256Of(canonicalManifestJson({ name: "lutaml-model-ts", revision: version })),
  });
  const byModule = new Map<string, { [key: string]: Plain }>();
  const add = (key: string, binding: { module: string; export: string }): void => {
    const group = byModule.get(binding.module) ?? {};
    group[key] = binding.export;
    byModule.set(binding.module, group);
  };
  for (const [id, binding] of Object.entries(bindings.types)) add(`type:${id}`, binding);
  for (const [id, binding] of Object.entries(bindings.classes ?? {})) add(`class:${id}`, binding);
  for (const [module, group] of byModule) {
    if (pins.has(module)) continue;
    pins.set(module, { revision: "binding", sha256: sha256Of(canonicalManifestJson(group)) });
  }
  return [...pins.keys()].sort(compareBytes).map((name) => ({ name, ...(pins.get(name) as { revision: string; sha256: Checksum }) }));
}

/**
 * Loads the bundle and produces models + codecs + manifest. Output depends
 * only on the inputs: same bytes in, same bytes out.
 */
export function generateArtifacts(input: ArtifactInput): ArtifactSet {
  const bundle: Bundle = loadBundle(input.bundleBytes, input.bundleFormat);
  const formats: KeyValueFormat[] = [...new Set<KeyValueFormat>(input.formats ?? ["json"])].sort(compareBytes);
  const contractsModule = input.contractsModule;
  const options = contractsModule === undefined ? {} : { contractsModule };
  const emitters = formats.map((format) => createKeyValueEmitter(format, options));
  const sources = generateModelsWith(bundle, input.bindings, emitters, options);

  const version = input.generatorVersion ?? packageVersion();
  const manifest: Manifest = {
    manifest: MANIFEST_VERSION,
    lml_checksum: bundleChecksum(bundle),
    schema_version: LML_DOCUMENT_VERSION,
    generator_version: `lutaml-model-ts/${version}`,
    target: "ts",
    capabilities: formats,
    corpora: [],
    files: [...sources.keys()].sort(compareBytes).map((path) => ({ path, sha256: sha256Of(sources.get(path) as string) })),
    dependencies: dependencyPins(input.bindings, version),
  };
  const manifestJson = canonicalManifestJson(manifest as unknown as Plain);
  const manifestSha256 = sha256Of(manifestJson);
  const files = new Map<string, string>(sources);
  files.set(MANIFEST_FILE, `${manifestJson}\n`);
  files.set(MANIFEST_DIGEST_FILE, `${manifestSha256}\n`);
  return { files: new Map([...files].sort(([a], [b]) => compareBytes(a, b))), manifest, manifestJson, manifestSha256 };
}

export interface StaleReport {
  readonly missing: readonly string[];
  readonly changed: readonly string[];
}

/** Compares generated files with a reader of the existing output; empty report means up to date. */
export function staleFiles(files: SourceMap, read: (path: string) => string | undefined): StaleReport {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [path, text] of files) {
    const existing = read(path);
    if (existing === undefined) missing.push(path);
    else if (existing !== text) changed.push(path);
  }
  return { missing, changed };
}

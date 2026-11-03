import type { Bundle, Checksum, LoadBundle, Manifest, ModelDocument, SchemaFormat } from "../contracts.js";
import {
  bundleCanonicalJson,
  bundleChecksum,
  checksumOf,
  legacyCanonicalJson,
  modelChecksum,
  rubyFloat,
  sortedCanonicalJson,
} from "./canonical.js";
import { parseRaw, RawFloat, type Raw } from "./raw.js";
import { validateRaw, type Tree, type TreeObject } from "./validator.js";

export { bundleCanonicalJson, bundleChecksum, modelChecksum, rubyFloat, RawFloat };

/**
 * A version-1 document, accepted unchanged. Unknown keys are tolerated and
 * ignored (legacy rule); values may hold RawFloat / bigint as the source did.
 */
export interface LegacyDocument {
  readonly lml: 1;
  readonly model: string;
  readonly register?: string | null;
  readonly attributes?: readonly TreeObject[];
  readonly mappings?: TreeObject;
  readonly [key: string]: Tree | undefined;
}

export type LoadedDocument =
  | { readonly version: 1; readonly document: LegacyDocument; readonly canonicalJson: string; readonly checksum: Checksum }
  | { readonly version: 2; readonly document: ModelDocument; readonly canonicalJson: string; readonly checksum: Checksum };

/** Parses and validates a single v1 or v2 model document. */
export function loadDocument(bytes: Uint8Array, format: SchemaFormat): LoadedDocument {
  const raw = parseRaw(bytes, format);
  const tree = validateRaw(raw, "document") as TreeObject;
  if (tree["lml"] === 1) {
    const canonicalJson = legacyCanonicalJson(raw);
    return { version: 1, document: tree as unknown as LegacyDocument, canonicalJson, checksum: checksumOf(canonicalJson) };
  }
  const canonicalJson = sortedCanonicalJson(tree);
  return { version: 2, document: tree as unknown as ModelDocument, canonicalJson, checksum: checksumOf(canonicalJson) };
}

/** Parses and validates a v1 bundle of v2 documents. Implements LoadBundle. */
export const loadBundle: LoadBundle = (bytes: Uint8Array, format: SchemaFormat): Bundle =>
  validateRaw(parseRaw(bytes, format), "bundle") as unknown as Bundle;

/** Parses and validates a generation manifest. */
export function loadManifest(bytes: Uint8Array, format: SchemaFormat): Manifest {
  return validateRaw(parseRaw(bytes, format), "manifest") as unknown as Manifest;
}

export type { Raw };

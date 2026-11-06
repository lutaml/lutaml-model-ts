import { createHash } from "node:crypto";
import { LmlError } from "../contracts.js";
import type { Bundle, Checksum } from "../contracts.js";
import { RawFloat, type Raw } from "./raw.js";
import { compareBytes, type Tree } from "./validator.js";

type Node = Raw | Tree | undefined;

/**
 * Ruby JSON.generate float text (json 3.x: fixed notation for decimal point
 * positions -8..15 plus 16 when the shortest digits are 17 long, otherwise `d[.ddd]e+XX`). v1 documents only.
 */
export function rubyFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new LmlError({ reason: "invalid_document", detail: "a non-finite float has no JSON form" });
  }
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exp = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const decpt = Number(exp) + 1;
  const sign = value < 0 ? "-" : "";
  if (decpt >= -8 && (decpt <= 15 || (decpt === 16 && digits.length === 17))) {
    if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  const e = decpt - 1;
  const frac = digits.length > 1 ? `.${digits.slice(1)}` : "";
  return `${sign}${digits[0]}${frac}e${e < 0 ? "-" : "+"}${Math.abs(e)}`;
}

function entriesOf(node: object): [string, Node][] {
  return node instanceof Map ? [...(node as Map<string, Node>)] : Object.entries(node);
}

/**
 * Compact JSON as Ruby's JSON.generate: no BOM or trailing newline, "/" and
 * non-ASCII unescaped. `sortKeys` sorts object keys by UTF-8 byte order.
 */
function generate(node: Node, sortKeys: boolean): string {
  if (node === null) return "null";
  if (node === undefined) throw new TypeError("undefined is not a LML value");
  switch (typeof node) {
    case "string": return JSON.stringify(node);
    case "boolean": return node ? "true" : "false";
    case "bigint": return node.toString();
    case "number":
      if (!Number.isInteger(node)) throw new TypeError("non-integer number: use RawFloat");
      return String(node);
    default:
  }
  if (node instanceof RawFloat) return rubyFloat(node.value);
  if (Array.isArray(node)) return `[${node.map((item: Node) => generate(item, sortKeys)).join(",")}]`;
  let entries = entriesOf(node as object);
  if (sortKeys) entries = entries.sort(([a], [b]) => compareBytes(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${generate(v, sortKeys)}`).join(",")}}`;
}

const sha256 = (text: string): Checksum => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** v1 canonical form: Document#to_h order, source order below it (never sorted). */
export function legacyCanonicalJson(raw: Raw): string {
  const map = raw as ReadonlyMap<string, Raw>;
  const out = new Map<string, Raw>();
  out.set("lml", 1);
  out.set("model", map.get("model") ?? null);
  const register = map.get("register");
  if (register !== undefined && register !== null) out.set("register", register);
  out.set("attributes", map.get("attributes") ?? []);
  out.set("mappings", map.get("mappings") ?? new Map());
  return generate(out, false);
}

/** v2 canonical form: recursively key-sorted, array order kept. */
export function sortedCanonicalJson(tree: Tree): string {
  return generate(tree, true);
}

export function checksumOf(canonicalJson: string): Checksum {
  return sha256(canonicalJson);
}

/** Canonical bundle JSON; the semantic identity excludes provenance. */
export function bundleCanonicalJson(bundle: Bundle, opts: { includeProvenance?: boolean } = {}): string {
  const { includeProvenance = true } = opts;
  const { provenance, ...rest } = bundle;
  const hash = includeProvenance && provenance !== undefined ? { ...rest, provenance } : rest;
  return generate(hash as unknown as Tree, true);
}

export function bundleChecksum(bundle: Bundle): Checksum {
  return sha256(bundleCanonicalJson(bundle, { includeProvenance: false }));
}

/** Checksum of one full model document inside a bundle. */
export function modelChecksum(bundle: Bundle, id: string): Checksum {
  const model = Object.hasOwn(bundle.models, id) ? bundle.models[id] : undefined;
  if (model === undefined) throw new RangeError(`no model ${id} in bundle`);
  return sha256(generate(model as unknown as Tree, true));
}

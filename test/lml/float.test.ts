import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadDocument } from "../../src/lml/index.js";
import { canonicalFloat, floatWire } from "../../src/lml/float.js";

interface Vectors {
  readonly encode: readonly { bits: string; wire: string }[];
  readonly canonical: readonly { text: string; canonical: boolean }[];
}
// Generated from Ruby (lutaml-model 02e DocumentValidator.float_wire / canonical_float?).
const vectors = JSON.parse(readFileSync(new URL("./fixtures/float_wire_vectors.json", import.meta.url), "utf8")) as Vectors;

export function fromBits(hex: string): number {
  return Buffer.from(hex, "hex").readDoubleBE(0);
}

describe("portable float wire form (Ruby vectors)", () => {
  for (const { bits, wire } of vectors.encode) {
    it(`renders ${wire} byte-for-byte and round-trips`, () => {
      const n = fromBits(bits);
      expect(floatWire(n)).toBe(wire);
      expect(canonicalFloat(wire)).toBe(true);
      expect(Object.is(Number(wire), n)).toBe(true);
    });
  }

  it("agrees with Ruby on which spellings are canonical", () => {
    for (const { text, canonical } of vectors.canonical) expect(canonicalFloat(text), JSON.stringify(text)).toBe(canonical);
  });

  it("refuses non-strings and non-finite values", () => {
    expect(canonicalFloat(0.71)).toBe(false);
    expect(canonicalFloat(null)).toBe(false);
    expect(() => floatWire(Number.NaN)).toThrow(RangeError);
    expect(() => floatWire(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("float in documents", () => {
  const doc = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({
      lml: 2,
      model: "Example::F",
      register: "default",
      attributes: [{ name: "ratio", type: { kind: "builtin", name: "float" }, default: { present: true, value } }],
      mappings: {},
    }));
  it("accepts a canonical string default and refuses a JSON number", () => {
    expect(() => loadDocument(doc("0.71"), "json")).not.toThrow();
    expect(() => loadDocument(doc("1.0e-5"), "json")).not.toThrow();
    expect(() => loadDocument(doc(0.5), "json")).toThrow(/invalid_document/);
    expect(() => loadDocument(doc("1.0e-05"), "json")).toThrow(/canonical float/);
  });
});

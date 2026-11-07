import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalFloat, floatWire } from "../../src/lml/float.js";

// Golden owned by lutaml-model (spec/fixtures/lml_conformance/float_vectors.json),
// copied byte-identical. Each row is a binary64 bit pattern and Ruby's wire text.
type Row = { bits: string; wire: string };
const rows = JSON.parse(readFileSync(new URL("./fixtures/float_vectors.json", import.meta.url), "utf8")) as Row[];
const bits = (hex: string): number => Buffer.from(hex, "hex").readDoubleBE(0);

describe("Ruby float_vectors golden", () => {
  it("has the shared rows", () => {
    expect(rows.length).toBeGreaterThan(2000);
  });
  it("renders every row exactly as Ruby and reads it back bit-exact", () => {
    const bad = rows.filter((r) => {
      const n = bits(r.bits);
      return floatWire(n) !== r.wire || !canonicalFloat(r.wire) || !Object.is(Number(r.wire), n);
    });
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

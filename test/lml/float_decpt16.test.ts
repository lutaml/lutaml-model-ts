import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rubyFloat } from "../../src/lml/canonical.js";
import { canonicalFloat, floatWire } from "../../src/lml/float.js";

const bits = (hex: string): number => Buffer.from(hex, "hex").readDoubleBE(0);

describe("decimal point 16 (Ruby Float#to_s plain only with 17 shortest digits)", () => {
  const cases: [number, string][] = [
    [1e14, "100000000000000.0"],
    [1e15, "1.0e15"],
    [1234567890123456.0, "1.234567890123456e15"],
    [1151450203773890.8, "1151450203773890.8"],
    [-1151450203773890.8, "-1151450203773890.8"],
    [1.2345678901234568e16, "1.2345678901234568e16"],
  ];
  for (const [n, wire] of cases) {
    it(`floatWire(${n}) is ${wire}`, () => {
      expect(floatWire(n)).toBe(wire);
      expect(canonicalFloat(wire)).toBe(true);
    });
  }
  it("rejects the exponent spelling of a plain-form value", () => {
    expect(canonicalFloat("1.1514502037738908e15")).toBe(false);
  });
  it("JSON.generate form follows the same rule", () => {
    expect(rubyFloat(1151450203773890.8)).toBe("1151450203773890.8");
    expect(rubyFloat(1e15)).toBe("1e+15");
    expect(rubyFloat(1234567890123456.0)).toBe("1.234567890123456e+15");
  });
  it("matches a Ruby sweep when the optional vector file is present", () => {
    const url = new URL("./fixtures/float_sweep_vectors.json", import.meta.url);
    if (!existsSync(url)) return;
    const rows = JSON.parse(readFileSync(url, "utf8")) as [string, string, string][];
    for (const [hex, to_s, json] of rows) {
      const n = bits(hex);
      const plain = !to_s.includes("e");
      expect(!floatWire(n).includes("e"), to_s).toBe(plain);
      expect(canonicalFloat(floatWire(n))).toBe(true);
      expect(Number(floatWire(n))).toBe(n);
      // Ruby's JSON generator may pick a different (equally round-tripping) last digit than
      // Float#to_s, so compare its plain/exponent decision and value, not the digit text.
      expect(rubyFloat(n).includes("e"), json).toBe(json.includes("e"));
      expect(Number(rubyFloat(n)), json).toBe(n);
    }
  });
});

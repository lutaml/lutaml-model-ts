import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import {
  add,
  canonicalDecimalString,
  checkNativeFacets,
  compareDecimal,
  decimalCanonical,
  decimalLexical,
  div,
  formatInteger,
  mul,
  parseDecimal,
  parseInteger,
  rational,
  rationalFromDecimalString,
  rationalToDecimalString,
  resolveValueType,
  sub,
} from "../../src/values/index.js";

interface Vectors {
  decimals: { input: string; canonical: string }[];
  rationals: {
    numerator: string;
    denominator: string;
    reduced: string;
    canonical: string | null;
    refusal: string | null;
  }[];
}
const vectors = JSON.parse(
  readFileSync(new URL("./exact-vectors.json", import.meta.url), "utf8"),
) as Vectors;

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof LmlError) return e.info.reason;
    throw e;
  }
  return undefined;
}

describe("Ruby-derived vectors", () => {
  for (const v of vectors.decimals) {
    it(`decimal ${v.input} -> ${v.canonical}`, () => {
      expect(canonicalDecimalString(v.input)).toBe(v.canonical);
      expect(decimalLexical(parseDecimal(v.input))).toBe(v.input);
    });
  }
  for (const v of vectors.rationals) {
    it(`rational ${v.numerator}/${v.denominator}`, () => {
      const r = rational(BigInt(v.numerator), BigInt(v.denominator));
      expect(`${r.numerator}/${r.denominator}`).toBe(v.reduced);
      if (v.refusal === null) {
        expect(rationalToDecimalString(r)).toBe(v.canonical);
      } else {
        expect(reason(() => rationalToDecimalString(r))).toBe(v.refusal);
      }
    });
  }
});

describe("exactness beyond IEEE-754", () => {
  it("0.1 + 0.2 is exactly 0.3", () => {
    const sum = add(rationalFromDecimalString("0.1"), rationalFromDecimalString("0.2"));
    expect(rationalToDecimalString(sum)).toBe("0.3");
  });
  it("keeps 30 significant digits and values beyond 2^53", () => {
    const s = "123456789012345678901234567890.123456789012345678901234567891";
    expect(canonicalDecimalString(s)).toBe(s);
    expect(formatInteger(parseInteger("9007199254740993"))).toBe("9007199254740993");
  });
  it("arithmetic is exact and division refuses nonterminating output", () => {
    const one = rational(1n);
    const three = rational(3n);
    const third = div(one, three);
    expect(reason(() => rationalToDecimalString(third))).toBe("nonterminating_rational");
    expect(rationalToDecimalString(mul(third, three))).toBe("1");
    expect(rationalToDecimalString(sub(one, rational(1n, 8n)))).toBe("0.875");
    expect(reason(() => div(one, rational(0n)))).toBe("invalid_document");
  });
  it("never rounds: error message is the only output of a refusal", () => {
    expect(() => rationalToDecimalString(rational(2n, 3n))).toThrow(/nonterminating|terminating/);
  });
});

describe("lexical preservation", () => {
  it("keeps trailing zeros on the wire but compares numerically", () => {
    const a = parseDecimal("1.50");
    const b = parseDecimal("1.5");
    expect(decimalLexical(a)).toBe("1.50");
    expect(decimalCanonical(a)).toBe("1.5");
    expect(compareDecimal(a, b)).toBe(0);
  });
});

describe("rejects non-portable lexical forms", () => {
  for (const bad of ["", ".", "1e3", "1E-2", " 1", "1 ", "1,5", "NaN", "Infinity", "0x10", "--1", "1.2.3"]) {
    it(`decimal ${JSON.stringify(bad)}`, () => {
      expect(reason(() => parseDecimal(bad))).toBe("invalid_document");
    });
  }
  for (const bad of ["", "1.0", "1e3", "abc", "+", " 5"]) {
    it(`integer ${JSON.stringify(bad)}`, () => {
      expect(reason(() => parseInteger(bad))).toBe("invalid_document");
    });
  }
  it("a JS number is refused, not coerced", () => {
    expect(reason(() => parseDecimal(0.1 as unknown as string))).toBe("invalid_document");
    expect(reason(() => parseInteger(5 as unknown as string))).toBe("invalid_document");
  });
});

describe("value type bindings", () => {
  const none = { types: {} };
  it("native bases resolve without a binding", () => {
    expect(resolveValueType("v", { base: "decimal", facets: { min: "0" } }, none).kind).toBe("native");
  });
  it("xml_id and custom bases require an explicit binding", () => {
    expect(reason(() => resolveValueType("Id@x", { base: "xml_id", facets: {} }, none))).toBe(
      "missing_type_binding",
    );
    const bound = { types: { "Id@x": { module: "./ids.js", export: "XmlId" } } };
    const r = resolveValueType("Id@x", { base: "xml_id", facets: { pattern: "[a-z]+" } }, bound);
    expect(r).toMatchObject({ kind: "bound", binding: { export: "XmlId" } });
  });
  it("prototype keys are not bindings", () => {
    expect(reason(() => resolveValueType("constructor", { base: "xml_id", facets: {} }, none))).toBe(
      "missing_type_binding",
    );
  });
  it("unknown facet on a native base rejects", () => {
    expect(reason(() => resolveValueType("v", { base: "string", facets: { bogus: 1 } }, none))).toBe(
      "unsupported_type",
    );
    expect(reason(() => resolveValueType("v", { base: "decimal", facets: { max_length: 3 } }, none))).toBe(
      "unsupported_type",
    );
  });
  it("numeric facets compare exactly, string facets validate", () => {
    const dec = resolveValueType("d", { base: "decimal", facets: { min: "0.1", max: 2 } }, none);
    expect(checkNativeFacets(dec, "0.10")).toBeNull();
    expect(checkNativeFacets(dec, "0.0999999999999999999999")).toBe("below min");
    expect(checkNativeFacets(dec, "2.0000000000000000001")).toBe("above max");
    const int = resolveValueType("i", { base: "integer", facets: { values: ["9007199254740993", 1] } }, none);
    expect(checkNativeFacets(int, "9007199254740993")).toBeNull();
    expect(checkNativeFacets(int, "9007199254740992")).toBe("not in values");
    const str = resolveValueType("s", { base: "string", facets: { min_length: 2, pattern: "[a-z]+" } }, none);
    expect(checkNativeFacets(str, "ab")).toBeNull();
    expect(checkNativeFacets(str, "a")).toBe("shorter than min_length");
    expect(checkNativeFacets(str, "AB")).toBe("does not match pattern");
  });
});

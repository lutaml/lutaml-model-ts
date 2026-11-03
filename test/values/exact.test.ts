import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import {
  add,
  canonicalDecimalString,
  compareDecimal,
  decimalCanonical,
  decimalLexical,
  div,
  formatInteger,
  mul,
  parseDecimal,
  parseInteger,
  MAX_DECIMAL_DIGITS,
  rational,
  rationalFromDecimalString,
  rationalToDecimalString,
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

describe("one facet vocabulary (REVIEW-TS-1 L10)", () => {
  it("src/values keeps no second facet vocabulary: facets live in the generator", async () => {
    const values = (await import("../../src/values/index.js")) as Record<string, unknown>;
    for (const name of ["resolveValueType", "checkNativeFacets", "NATIVE_BASES"]) {
      expect(values[name], name).toBeUndefined();
    }
  });
});

describe("bounded decimal parsing (REVIEW-TS-1 M3)", () => {
  const digits = (n: number): string => "3." + "7".repeat(n - 1);

  it("refuses an over-long lexical by name, quickly", () => {
    const started = performance.now();
    for (const lexical of [digits(40_000), "1".repeat(MAX_DECIMAL_DIGITS + 1), "0." + "0".repeat(MAX_DECIMAL_DIGITS)]) {
      try {
        parseDecimal(lexical);
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(LmlError);
        expect((e as LmlError).info).toMatchObject({ reason: "invalid_document", rule: "max_decimal_digits" });
      }
    }
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("accepts the limit itself and parses it in bounded time (40,000 digits took 3.8 s before)", () => {
    const started = performance.now();
    const d = parseDecimal(digits(MAX_DECIMAL_DIGITS));
    expect(d.value.denominator > 0n).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("strips 2 and 5 factors exactly like gcd reduction", () => {
    const cases = ["0.5", "0.25", "0.125", "2.50", "-0.075", "10.00", "-0", "0.000", "12.3400", "1000", "0.2", "0.04", "100.001", "6.25", "-1.5"];
    for (const lexical of cases) {
      const got = rationalFromDecimalString(lexical);
      const scale = lexical.includes(".") ? lexical.split(".")[1]?.length ?? 0 : 0;
      const sign = lexical.startsWith("-") ? -1n : 1n;
      const expected = rational(sign * BigInt(lexical.replace(/^-/, "").replace(".", "")), 10n ** BigInt(scale));
      expect(got, lexical).toEqual(expected);
    }
  });
});

import { describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import {
  formatDecimal, formatRational, isDecimal, isRational, parseDecimal, parseRational,
} from "../../src/codecs/exact.js";

describe("exact binding adapter", () => {
  it("keeps the decimal lexical form and recognises its own values", () => {
    const d = parseDecimal("+001.500");
    expect(formatDecimal(d)).toBe("+001.500");
    expect(isDecimal(d)).toBe(true);
    expect(isDecimal({ lexical: "1" })).toBe(false);
    expect(isDecimal(null)).toBe(false);
  });

  it("formats terminating rationals and refuses the rest", () => {
    const r = parseRational("0.125");
    expect(isRational(r)).toBe(true);
    expect(formatRational(r)).toBe("0.125");
    const refusal = ((): unknown => {
      try {
        formatRational({ numerator: 1n, denominator: 3n });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(LmlError);
    expect((refusal as LmlError).info.reason).toBe("nonterminating_rational");
  });
});

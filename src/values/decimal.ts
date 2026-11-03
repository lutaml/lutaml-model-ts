import {
  compare as compareRational,
  rationalFromDecimalString,
  rationalToDecimalString,
} from "./rational.js";
import type { Rational } from "./rational.js";

/**
 * A decimal value that keeps its source lexical form (trailing zeros,
 * leading zeros, explicit `+`) next to its exact numeric value.
 */
export interface ExactDecimal {
  readonly lexical: string;
  readonly value: Rational;
}

export function parseDecimal(lexical: string): ExactDecimal {
  return Object.freeze({ lexical, value: rationalFromDecimalString(lexical) });
}

/** Wire form: the preserved source lexical string, unchanged. */
export function decimalLexical(d: ExactDecimal): string {
  return d.lexical;
}

/** Canonical (normalized) decimal string of the exact value. */
export function decimalCanonical(d: ExactDecimal): string {
  return rationalToDecimalString(d.value);
}

/** Numeric comparison; lexical differences such as `1.50` vs `1.5` are equal. */
export function compareDecimal(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  return compareRational(a.value, b.value);
}

/** Canonicalize a decimal string without keeping the lexical form. */
export function canonicalDecimalString(lexical: string): string {
  return rationalToDecimalString(rationalFromDecimalString(lexical));
}

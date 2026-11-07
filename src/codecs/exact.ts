/**
 * Binding adapter over the exact value helpers (src/values), following the
 * TypeBinding convention the generators expect of a module: the exported type
 * plus `is<Export>`, `parse<Export>` and `format<Export>`. Bind
 * `builtin:decimal` to export `Decimal` and `builtin:rational` to `Rational`
 * from this module (or a re-export of it).
 */
import {
  decimalLexical,
  parseDecimal as parseExactDecimal,
  rationalFromDecimalString,
  rationalToDecimalString,
} from "../values/index.js";
import type { ExactDecimal, Rational as ExactRational } from "../values/index.js";

export type Decimal = ExactDecimal;
export type Rational = ExactRational;

export function isDecimal(value: unknown): value is Decimal {
  if (typeof value !== "object" || value === null) return false;
  const o = value as { readonly lexical?: unknown; readonly value?: unknown };
  return typeof o.lexical === "string" && isRational(o.value);
}

export const parseDecimal: (lexical: string) => Decimal = parseExactDecimal;
export const formatDecimal: (value: Decimal) => string = decimalLexical;

export function isRational(value: unknown): value is Rational {
  if (typeof value !== "object" || value === null) return false;
  const o = value as { readonly numerator?: unknown; readonly denominator?: unknown };
  return typeof o.numerator === "bigint" && typeof o.denominator === "bigint" && o.denominator > 0n;
}

export const parseRational: (lexical: string) => Rational = rationalFromDecimalString;
/** Refuses a rational with no finite decimal expansion (nonterminating_rational). */
export const formatRational: (value: Rational) => string = rationalToDecimalString;

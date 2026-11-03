import { valueError } from "./errors.js";

/** Exact rational: reduced, denominator strictly positive. */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Build a reduced rational. A zero denominator is refused. */
export function rational(numerator: bigint, denominator: bigint = 1n): Rational {
  if (denominator === 0n) {
    throw valueError("invalid_document", "rational with zero denominator");
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  if (g > 1n) {
    n /= g;
    d /= g;
  }
  if (n === 0n) d = 1n;
  return Object.freeze({ numerator: n, denominator: d });
}

export function add(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function sub(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function mul(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.numerator === 0n) {
    throw valueError("invalid_document", "division by zero");
  }
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}

/** -1, 0 or 1. */
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const l = a.numerator * b.denominator;
  const r = b.numerator * a.denominator;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function equals(a: Rational, b: Rational): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

const DECIMAL_LEXICAL = /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/;

/**
 * Exact value of a plain decimal lexical string (`[+-]?digits[.digits]`,
 * at least one digit). Exponent notation is refused: it is not part of the
 * portable decimal-string profile.
 */
export function rationalFromDecimalString(lexical: string): Rational {
  const m = typeof lexical === "string" ? DECIMAL_LEXICAL.exec(lexical) : null;
  const intPart = m?.[2] ?? "";
  const fracPart = m?.[3] ?? "";
  if (m === null || intPart.length + fracPart.length === 0) {
    throw valueError("invalid_document", `not a decimal string: ${JSON.stringify(lexical)}`);
  }
  const digits = BigInt(intPart + fracPart);
  const signed = m[1] === "-" ? -digits : digits;
  return rational(signed, 10n ** BigInt(fracPart.length));
}

/**
 * Canonical decimal string of a rational: minimal digits (no trailing
 * fractional zeros, no `.0`, no `+`, no negative zero). A rational whose
 * reduced denominator has a prime factor other than 2 or 5 has no finite
 * decimal expansion and is refused with `nonterminating_rational`; nothing
 * is rounded.
 */
export function rationalToDecimalString(value: Rational): string {
  let d = value.denominator;
  let twos = 0n;
  let fives = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  if (d !== 1n) {
    throw valueError(
      "nonterminating_rational",
      `${value.numerator}/${value.denominator} has no terminating decimal expansion`,
    );
  }
  const scale = twos > fives ? twos : fives;
  const scaled = (abs(value.numerator) * 10n ** scale) / value.denominator;
  const sign = value.numerator < 0n ? "-" : "";
  if (scale === 0n) return sign + scaled.toString(10);
  const digits = scaled.toString(10).padStart(Number(scale) + 1, "0");
  const cut = digits.length - Number(scale);
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

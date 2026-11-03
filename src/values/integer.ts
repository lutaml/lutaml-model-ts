import { valueError } from "./errors.js";

const INTEGER_LEXICAL = /^[+-]?[0-9]+$/;

/**
 * Parse an exact integer lexical string (`[+-]?digits`) into a bigint.
 * Never passes through `number`. Rejects exponent, fraction, whitespace.
 */
export function parseInteger(lexical: string): bigint {
  if (typeof lexical !== "string" || !INTEGER_LEXICAL.test(lexical)) {
    throw valueError("invalid_document", `not an exact integer string: ${JSON.stringify(lexical)}`);
  }
  return BigInt(lexical);
}

/** Canonical decimal digits: no `+`, no leading zeros, `0` for zero. */
export function formatInteger(value: bigint): string {
  return value.toString(10);
}

import { CANONICAL_FLOAT_FN_SRC, FLOAT_WIRE_FN_SRC, FLOAT_WIRE_SRC } from "../codecs/float-source.js";

/**
 * Portable `float` wire form: IEEE-754 binary64 as a string of Ruby's
 * shortest round-trip digits (Float#to_s) with one exponent spelling:
 * lowercase `e`, no `+`, no leading zeros, mantissa always has a fraction
 * digit ("0.71", "1.0e-5", "1.0e20", "3.0", "-0.0"). Mirrors Ruby's
 * DocumentValidator.float_wire / .canonical_float?.
 *
 * Ruby switches to exponent form when the decimal point position is
 * <= -4 or > 15, except decpt 16 with a 17-digit shortest string stays plain; JS Number#toString uses different thresholds, so the digits
 * come from toExponential() (shortest round-trip) and are re-spelled here.
 *
 * The code itself lives as text in ./float-source.ts (the generated runtimes
 * embed the same bytes); this module evaluates that text.
 */
const impl = new Function(
  `const FLOAT_WIRE = ${FLOAT_WIRE_SRC}; const floatWire = ${FLOAT_WIRE_FN_SRC}; const canonicalFloat = ${CANONICAL_FLOAT_FN_SRC}; return { FLOAT_WIRE, floatWire, canonicalFloat };`,
)() as { FLOAT_WIRE: RegExp; floatWire: (value: number) => string; canonicalFloat: (value: unknown) => boolean };

export const FLOAT_WIRE: RegExp = impl.FLOAT_WIRE;

export const floatWire: (value: number) => string = impl.floatWire;

/** True only for a string equal to the re-rendering of its own binary64 value. */
export const canonicalFloat = impl.canonicalFloat as (value: unknown) => value is string;

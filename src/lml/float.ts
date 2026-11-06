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
 */
export const FLOAT_WIRE = /^-?[0-9]+\.[0-9]+(?:e-?[0-9]+)?$/;

export function floatWire(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("non-finite float");
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exp = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const decpt = Number(exp) + 1;
  const sign = value < 0 ? "-" : "";
  if (decpt > -4 && (decpt <= 15 || (decpt === 16 && digits.length === 17))) {
    if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
    if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  return `${sign}${digits[0]}.${digits.length > 1 ? digits.slice(1) : "0"}e${decpt - 1}`;
}

/** True only for a string equal to the re-rendering of its own binary64 value. */
export function canonicalFloat(value: unknown): value is string {
  if (typeof value !== "string" || !FLOAT_WIRE.test(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && floatWire(n) === value;
}

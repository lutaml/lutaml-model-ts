/**
 * The ONE source of the portable `float` wire code. It is text, not a
 * function, on purpose: the generated runtimes embed these exact bytes, and
 * `Function.prototype.toString` returns whatever the toolchain compiled
 * (esbuild under vitest, tsc in dist), which changed the generated digest.
 * src/lml/float.ts evaluates this same text, so library and generated code
 * cannot drift. The text is plain JavaScript (no backticks, so it fits a
 * String.raw template) that is also valid strict TypeScript once the arrow
 * functions get their contextual types from the assertions in
 * `floatRuntimeSource()`.
 */
export const FLOAT_WIRE_SRC = String.raw`/^-?[0-9]+\.[0-9]+(?:e-?[0-9]+)?$/`;

export const FLOAT_WIRE_FN_SRC = String.raw`(value) => {
  if (!Number.isFinite(value)) throw new RangeError("non-finite float");
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exp = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const decpt = Number(exp) + 1;
  const sign = value < 0 ? "-" : "";
  if (decpt > -4 && (decpt <= 15 || (decpt === 16 && digits.length === 17))) {
    if (decpt <= 0) return sign + "0." + "0".repeat(-decpt) + digits;
    if (decpt >= digits.length) return sign + digits + "0".repeat(decpt - digits.length) + ".0";
    return sign + digits.slice(0, decpt) + "." + digits.slice(decpt);
  }
  return sign + digits[0] + "." + (digits.length > 1 ? digits.slice(1) : "0") + "e" + (decpt - 1);
}`;

export const CANONICAL_FLOAT_FN_SRC = String.raw`(value) => {
  if (typeof value !== "string" || !FLOAT_WIRE.test(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && floatWire(n) === value;
}`;

/** Generated-runtime form: typed through assertions, byte-stable by construction. */
export function floatRuntimeSource(): string {
  return (
    "\n" +
    `const FLOAT_WIRE = ${FLOAT_WIRE_SRC};\n` +
    `const floatWire = (${FLOAT_WIRE_FN_SRC}) as (value: number) => string;\n` +
    `const canonicalFloat = (${CANONICAL_FLOAT_FN_SRC}) as (value: unknown) => boolean;\n`
  );
}

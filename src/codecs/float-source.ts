import { canonicalFloat, FLOAT_WIRE, floatWire } from "../lml/float.js";

/**
 * Float wire code for the generated runtimes, taken from src/lml/float.ts
 * itself (Function.prototype.toString) so there is ONE implementation. The
 * emitted `const`s are typed through assertions because the function text is
 * the compiled JavaScript form. Generated code must not depend on helper
 * names a transform may inject, so the result is checked here.
 */
export function floatRuntimeSource(): string {
  const source = [
    `const FLOAT_WIRE = ${FLOAT_WIRE.toString()};`,
    `const floatWire = (${floatWire.toString()}) as (value: number) => string;`,
    `const canonicalFloat = (${canonicalFloat.toString()}) as (value: unknown) => boolean;`,
  ].join("\n");
  if (/\b__name\b|\b__vite|\bcov_|\b_ts_/.test(source)) {
    throw new Error("float.ts was transformed with helper calls; cannot embed it as generated runtime source");
  }
  return `\n${source}\n`;
}

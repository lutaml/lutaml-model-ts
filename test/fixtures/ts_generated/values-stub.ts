// Local stand-in for the 06d exact-value types. Convention the generator
// expects of a TypeBinding: the exported type, plus `is<Export>` and
// `parse<Export>` functions in the same module.

export interface Decimal {
  readonly lexical: string;
}

export function isDecimal(value: unknown): value is Decimal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { lexical?: unknown }).lexical === "string"
  );
}

export function parseDecimal(lexical: string): Decimal {
  return { lexical };
}

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function isRational(value: unknown): value is Rational {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { numerator?: unknown }).numerator === "bigint"
  );
}

export function parseRational(lexical: string): Rational {
  return { numerator: BigInt(lexical), denominator: 1n };
}

export type XmlId = string;

export function isXmlId(value: unknown): value is XmlId {
  return typeof value === "string" && /^[A-Za-z_][\w.-]*$/.test(value);
}

export function parseXmlId(lexical: string): XmlId {
  return lexical;
}

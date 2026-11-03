import { LmlError } from "../contracts.js";
import type { Bindings, NeutralValue, TypeBinding, ValueTypeSpec } from "../contracts.js";
import { compare, rationalFromDecimalString } from "./rational.js";
import type { Rational } from "./rational.js";
import { parseInteger } from "./integer.js";

/** Builtin bases the TS target implements natively. Anything else needs a binding. */
export const NATIVE_BASES = [
  "string",
  "integer",
  "decimal",
] as const;
export type NativeBase = (typeof NATIVE_BASES)[number];

const STRING_FACETS = ["values", "min_length", "max_length", "pattern"] as const;
const NUMERIC_FACETS = ["values", "min", "max"] as const;

export type ResolvedValueType =
  | {
      readonly kind: "native";
      readonly base: NativeBase;
      readonly facets: { readonly [facet: string]: NeutralValue };
    }
  | {
      readonly kind: "bound";
      readonly binding: TypeBinding;
      readonly base: string;
      readonly facets: { readonly [facet: string]: NeutralValue };
    };

function isNative(base: string): base is NativeBase {
  return (NATIVE_BASES as readonly string[]).includes(base);
}

/**
 * Resolve a value type to a native implementation or an explicit trusted
 * binding. A base without native support (including `xml_id` and custom
 * types) and no binding is `missing_type_binding`; an unknown facet on a
 * native base is `unsupported_type`. Nothing is guessed.
 */
export function resolveValueType(
  id: string,
  spec: ValueTypeSpec,
  bindings: Bindings,
): ResolvedValueType {
  if (isNative(spec.base)) {
    const allowed: readonly string[] = spec.base === "string" ? STRING_FACETS : NUMERIC_FACETS;
    for (const facet of Object.keys(spec.facets)) {
      if (!allowed.includes(facet)) {
        throw new LmlError({
          reason: "unsupported_type",
          detail: `unknown facet ${JSON.stringify(facet)} on ${spec.base} value type ${id}`,
        });
      }
    }
    return { kind: "native", base: spec.base, facets: spec.facets };
  }
  const binding = Object.hasOwn(bindings.types, id) ? bindings.types[id] : undefined;
  if (binding === undefined) {
    throw new LmlError({
      reason: "missing_type_binding",
      detail: `value type ${id} (base ${spec.base}) has no trusted binding`,
    });
  }
  return { kind: "bound", binding, base: spec.base, facets: spec.facets };
}

/**
 * Check a lexical string against a native resolved type's facets.
 * Returns the problem text, or null when valid.
 */
export function checkNativeFacets(type: ResolvedValueType, lexical: string): string | null {
  if (type.kind !== "native") return null;
  const f = type.facets;
  if (type.base === "string") {
    const len = [...lexical].length;
    if (typeof f["min_length"] === "number" && len < f["min_length"]) return "shorter than min_length";
    if (typeof f["max_length"] === "number" && len > f["max_length"]) return "longer than max_length";
    if (typeof f["pattern"] === "string" && !new RegExp(`^(?:${f["pattern"]})$`, "u").test(lexical)) {
      return "does not match pattern";
    }
    if (Array.isArray(f["values"]) && !f["values"].includes(lexical)) return "not in values";
    return null;
  }
  const isInt = type.base === "integer";
  const bound = (v: NeutralValue | undefined): Rational | null => {
    if (v === undefined) return null;
    if (typeof v === "number" && Number.isSafeInteger(v)) return rationalFromDecimalString(String(v));
    if (typeof v === "string") return rationalFromDecimalString(v);
    throw new LmlError({ reason: "unsupported_type", detail: "numeric facet must be an integer or decimal string" });
  };
  const x = rationalFromDecimalString(isInt ? parseInteger(lexical).toString() : lexical);
  const min = bound(f["min"]);
  const max = bound(f["max"]);
  if (min !== null && compare(x, min) < 0) return "below min";
  if (max !== null && compare(x, max) > 0) return "above max";
  if (Array.isArray(f["values"])) {
    const ok = f["values"].some((v) => {
      const r = bound(v);
      return r !== null && compare(x, r) === 0;
    });
    if (!ok) return "not in values";
  }
  return null;
}

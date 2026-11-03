import type {
  AttributeSpec,
  Bindings,
  Bundle,
  Discriminator,
  ModelDocument,
  ModelId,
  NeutralValue,
  TypeBinding,
  ValueTypeId,
} from "../contracts.js";
import { canonicalFloat } from "../lml/float.js";
import { compareBytes } from "../lml/validator.js";
import { fail, isIdentifier } from "./names.js";
import { vetPattern } from "./regex.js";

/** Generation-time view of one element type (the scalar or collection item). */
export interface ElementPlan {
  /** TypeScript type expression of one non-null element. */
  readonly ts: string;
  /** Expression of type `rt.Check`. */
  readonly check: string;
  /** Renders a neutral default/enum value as a TS expression of `ts`. */
  readonly literal: ((value: NeutralValue, reject: Reject) => string) | null;
}

export type Reject = (detail: string) => never;

export interface BoundImport {
  readonly alias: string;
  readonly binding: TypeBinding;
  parse: boolean;
}

const STRING_FAMILY = new Set(["string", "token", "uri", "email", "hostname", "ip", "symbol"]);
const LEXICAL_CHECKS: Readonly<Record<string, string>> = {
  date: "rt.date",
  date_time: "rt.dateTime",
  time: "rt.time",
  time_without_date: "rt.timeWithoutDate",
  duration: "rt.duration",
};
const EXACT_BUILTINS = new Set(["decimal", "rational"]);
const KNOWN_BUILTINS = new Set([
  ...STRING_FAMILY, ...Object.keys(LEXICAL_CHECKS), ...EXACT_BUILTINS,
  "boolean", "integer", "float", "qname", "base64_binary", "hex_binary", "hash",
]);
const UNSUPPORTED_BUILTINS = new Set(["double"]);
const STRING_FACETS: Readonly<Record<string, string>> = {
  min_length: "minLength", max_length: "maxLength", length: "length", pattern: "pattern",
};
const INTEGER_FACETS: Readonly<Record<string, string>> = {
  min_inclusive: "minInclusive", max_inclusive: "maxInclusive",
  min_exclusive: "minExclusive", max_exclusive: "maxExclusive",
};

/** A float default is the canonical wire string; it is emitted as the exact binary64 literal. */
function floatLiteral(value: NeutralValue, reject: Reject): string {
  if (!canonicalFloat(value)) return reject("float defaults are canonical float strings");
  return value;
}

/** Own-property lookup: names like "constructor" or "__proto__" never reach Object.prototype. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export class PlanContext {
  private readonly imports = new Map<string, BoundImport>();
  private readonly valueConsts = new Map<ValueTypeId, ElementPlan>();
  readonly valueConstLines: string[] = [];

  constructor(
    readonly bundle: Bundle,
    readonly bindings: Bindings,
    readonly classNames: ReadonlyMap<ModelId, string>,
  ) {}

  boundImports(): readonly BoundImport[] {
    return [...this.imports.values()];
  }

  private bind(key: string, binding: TypeBinding, modelId: string): BoundImport {
    if (!isIdentifier(binding.export) || typeof binding.module !== "string" || binding.module === "") {
      return fail({
        reason: "invalid_document",
        model_id: modelId,
        detail: `binding for ${key} needs a module and an identifier export`,
      });
    }
    const id = binding.module + "\u0000" + binding.export;
    const known = this.imports.get(id);
    if (known !== undefined) return known;
    const made: BoundImport = { alias: `_b${this.imports.size}`, binding, parse: false };
    this.imports.set(id, made);
    return made;
  }

  private boundPlan(key: string, label: string, binding: TypeBinding, modelId: string): ElementPlan {
    const bound = this.bind(key, binding, modelId);
    return {
      ts: bound.alias,
      check: `rt.guard(${bound.alias}_is, ${JSON.stringify(label)})`,
      literal: (value, reject) => {
        if (typeof value !== "string") return reject(`${label} defaults are lexical strings`);
        bound.parse = true;
        return `${bound.alias}_parse(${JSON.stringify(value)})`;
      },
    };
  }

  private assertKnownBuiltin(name: string, modelId: string, attribute: string): void {
    if (UNSUPPORTED_BUILTINS.has(name)) {
      fail({ reason: "unsupported_type", model_id: modelId, attribute, detail: name });
    }
    if (!KNOWN_BUILTINS.has(name)) {
      fail({ reason: "unknown_type", model_id: modelId, attribute, detail: name });
    }
  }

  builtinPlan(name: string, modelId: string, attribute: string): ElementPlan {
    this.assertKnownBuiltin(name, modelId, attribute);
    if (EXACT_BUILTINS.has(name)) {
      const key = `builtin:${name}`;
      const binding = own(this.bindings.types, key);
      if (binding === undefined) {
        return fail({
          reason: "missing_type_binding",
          model_id: modelId,
          attribute,
          detail: `exact ${name} needs a binding under ${key}`,
        });
      }
      return this.boundPlan(key, name, binding, modelId);
    }
    if (STRING_FAMILY.has(name)) {
      return { ts: "string", check: name === "token" ? "rt.token" : "rt.str", literal: stringLiteral };
    }
    const lexical = own(LEXICAL_CHECKS, name);
    if (lexical !== undefined) return { ts: "string", check: lexical, literal: stringLiteral };
    switch (name) {
      case "boolean":
        return {
          ts: "boolean",
          check: "rt.bool",
          literal: (v, reject) => (typeof v === "boolean" ? String(v) : reject("expected a boolean")),
        };
      case "integer":
        return { ts: "bigint", check: "rt.int", literal: (v, reject) => integerLiteral(v, reject) };
      case "float":
        return { ts: "number", check: "rt.float", literal: floatLiteral };
      case "qname":
        return { ts: "rt.QName", check: "rt.qname", literal: qnameLiteral };
      case "base64_binary":
        return { ts: "Uint8Array", check: "rt.bytes", literal: (v, reject) => bytesLiteral(v, "base64", reject) };
      case "hex_binary":
        return { ts: "Uint8Array", check: "rt.bytes", literal: (v, reject) => bytesLiteral(v, "hex", reject) };
      default:
        return { ts: "rt.NeutralObject", check: "rt.neutralObject", literal: hashLiteral };
    }
  }

  /** A named value type: trusted binding, or base plus a closed facet set. */
  valuePlan(id: ValueTypeId, modelId: string, attribute: string): ElementPlan {
    const cached = this.valueConsts.get(id);
    if (cached !== undefined) return cached;
    const spec = own(this.bundle.value_types, id);
    if (spec === undefined) {
      return fail({ reason: "dangling_reference", model_id: modelId, attribute, detail: `value type ${id}` });
    }
    const binding = own(this.bindings.types, id);
    let plan: ElementPlan;
    if (binding !== undefined) {
      this.assertKnownBuiltin(spec.base, modelId, attribute);
      plan = this.boundPlan(id, id, binding, modelId);
    } else {
      const base = this.builtinPlan(spec.base, modelId, attribute);
      const facetNames = Object.keys(spec.facets).sort(compareBytes);
      if (facetNames.length === 0) {
        plan = base;
      } else {
        plan = this.facetPlan(id, spec.base, base, spec.facets, facetNames, modelId, attribute);
      }
    }
    const named = this.hoist(plan);
    this.valueConsts.set(id, named);
    return named;
  }

  private hoist(plan: ElementPlan): ElementPlan {
    if (plan.check.startsWith("rt.") && !plan.check.includes("(")) return plan;
    const name = `_vt${this.valueConstLines.length}`;
    this.valueConstLines.push(`const ${name} = ${plan.check};`);
    return { ...plan, check: name };
  }

  private facetPlan(
    id: string,
    baseName: string,
    base: ElementPlan,
    facets: Readonly<Record<string, NeutralValue>>,
    names: readonly string[],
    modelId: string,
    attribute: string,
  ): ElementPlan {
    const unbound = (facet: string): never =>
      fail({
        reason: "missing_type_binding",
        model_id: modelId,
        attribute,
        detail: `value type ${id}: facet ${facet} on ${baseName} needs a trusted binding`,
      });
    const badFacet = (facet: string, why: string): never =>
      fail({ reason: "invalid_document", model_id: modelId, attribute, detail: `value type ${id}: facet ${facet} ${why}` });
    const stringy = STRING_FAMILY.has(baseName);
    const integer = baseName === "integer";
    const parts: string[] = [];
    let enumeration: NeutralValue | undefined;
    for (const name of names) {
      const value = facets[name] as NeutralValue;
      if (name === "enumeration" && base.literal !== null && (stringy || integer || baseName === "boolean")) {
        enumeration = value;
      } else if (stringy && Object.hasOwn(STRING_FACETS, name)) {
        if (name === "pattern") {
          if (typeof value !== "string") return badFacet(name, "must be a string");
          // The runtime compiles the wrapped form; compile the bare form too so a
          // pattern like "a)|(?:b" cannot escape the wrapper.
          for (const source of ["^(?:" + value + ")$", value]) {
            try {
              new RegExp(source, "u");
            } catch {
              return badFacet(name, "is not a portable regular expression");
            }
          }
          const verdict = vetPattern(value);
          if (verdict.topAlternation) {
            return badFacet(name, "has a top-level alternation that the ^(?:...)$ wrapper would change; group it explicitly");
          }
          if (!verdict.ok) return badFacet(name, `is refused: ${verdict.why ?? "unsafe regular expression"}`);
          parts.push(`pattern: ${JSON.stringify(value)}`);
        } else {
          if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
            return badFacet(name, "must be a non-negative integer");
          }
          parts.push(`${STRING_FACETS[name]}: ${value}`);
        }
      } else if (integer && Object.hasOwn(INTEGER_FACETS, name)) {
        parts.push(`${INTEGER_FACETS[name]}: ${integerLiteral(value, (d) => badFacet(name, d))}`);
      } else {
        return unbound(name);
      }
    }
    let check = base.check;
    if (parts.length > 0) {
      const helper = stringy ? "rt.stringFacets" : "rt.integerFacets";
      check = `${helper}(${check}, { ${parts.join(", ")} })`;
    }
    if (enumeration !== undefined) {
      if (!Array.isArray(enumeration) || enumeration.length === 0) return badFacet("enumeration", "must be a non-empty array");
      const literal = base.literal as NonNullable<ElementPlan["literal"]>;
      const lits = enumeration.map((entry) => literal(entry, (d) => badFacet("enumeration", d)));
      const enumCheck = `rt.oneOf([${lits.join(", ")}])`;
      return {
        ts: lits.join(" | "),
        check: parts.length > 0 ? `rt.anyOf([${enumCheck}], "an enumerated value")` : enumCheck,
        literal: base.literal,
      };
    }
    return { ts: base.ts, check, literal: base.literal };
  }

  /** Wraps a plan for an attribute's closed value list (typed enum). */
  enumPlan(base: ElementPlan, values: readonly NeutralValue[], modelId: string, attribute: string): ElementPlan {
    const reject: Reject = (detail) =>
      fail({ reason: "invalid_document", model_id: modelId, attribute, location: "/values", detail });
    if (base.literal === null || values.length === 0) return reject("enum values need a literal-capable type");
    const lits = values.map((value) => (base.literal as NonNullable<ElementPlan["literal"]>)(value, reject));
    if (lits.includes("null") || base.ts.startsWith("rt.") || base.ts === "Uint8Array" || base.ts.startsWith("_b")) {
      return reject("enum values are not supported for this type");
    }
    return {
      ts: lits.join(" | "),
      check: `rt.oneOf([${lits.join(", ")}])`,
      literal: (value, rej) => {
        const lit = (base.literal as NonNullable<ElementPlan["literal"]>)(value, rej);
        return lits.includes(lit) ? lit : rej("default is not one of the enum values");
      },
    };
  }
}

function stringLiteral(value: NeutralValue, reject: Reject): string {
  return typeof value === "string" ? JSON.stringify(value) : reject("expected a string");
}

function integerLiteral(value: NeutralValue, reject: Reject): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return `${value}n`;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return `${BigInt(value)}n`;
  return reject("expected an integer");
}

function qnameLiteral(value: NeutralValue, reject: Reject): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return reject("expected a QName object");
  const record = value as { readonly [key: string]: NeutralValue };
  const local = record["local"];
  const namespace = record["namespace"];
  if (typeof local !== "string" || (namespace !== null && typeof namespace !== "string")) {
    return reject("QName needs string local and string-or-null namespace");
  }
  return `{ namespace: ${JSON.stringify(namespace)}, local: ${JSON.stringify(local)} }`;
}

function bytesLiteral(value: NeutralValue, form: "base64" | "hex", reject: Reject): string {
  if (typeof value !== "string") return reject("expected a lexical string");
  const valid = form === "hex" ? /^(?:[0-9a-fA-F]{2})*$/.test(value) : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  if (!valid) return reject(`not valid ${form}`);
  return `new Uint8Array([${[...Buffer.from(value, form)].join(", ")}])`;
}

function hashLiteral(value: NeutralValue, reject: Reject): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return reject("expected an object");
  // JSON.parse keeps a "__proto__" key as an own key; an object literal would set the prototype.
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))}) as rt.NeutralObject`;
}

function canonical(disc: Discriminator): string {
  const cases = Object.keys(disc.cases).sort(compareBytes).map((k) => [k, disc.cases[k]]);
  return JSON.stringify([disc.attribute, cases]);
}

/**
 * The discriminator that governs an attribute: the attribute-level one and any
 * rule-level one (how Ruby exports key-value polymorphism) on a rule targeting
 * the attribute, in any format. All sources must agree; disagreement is refused.
 */
export function effectiveDiscriminator(
  doc: ModelDocument | undefined,
  attr: AttributeSpec,
  modelId: string,
): Discriminator | undefined {
  const sources: { readonly from: string; readonly disc: Discriminator }[] = [];
  if (attr.discriminator !== undefined) sources.push({ from: "attribute", disc: attr.discriminator });
  for (const [format, mapping] of Object.entries(doc?.mappings ?? {})) {
    const rules = (mapping as { readonly rules?: readonly { readonly to?: string; readonly discriminator?: Discriminator }[] } | undefined)?.rules ?? [];
    for (const rule of rules) {
      if (rule.to === attr.name && rule.discriminator !== undefined) sources.push({ from: `${format} rule`, disc: rule.discriminator });
    }
  }
  const [first, ...rest] = sources;
  if (first === undefined) return undefined;
  const clash = rest.find((source) => canonical(source.disc) !== canonical(first.disc));
  if (clash !== undefined) {
    return fail({
      reason: "unsupported_mapping",
      model_id: modelId,
      attribute: attr.name,
      detail: `discriminator of the ${first.from} disagrees with the ${clash.from}`,
    });
  }
  return first.disc;
}

/** Resolves an attribute's element plan (type ref, discriminator, enum). */
export function planAttribute(ctx: PlanContext, attr: AttributeSpec, modelId: string): ElementPlan {
  const { type } = attr;
  const where = { model_id: modelId, attribute: attr.name } as const;
  let plan: ElementPlan;
  if (type.kind === "builtin") {
    plan = ctx.builtinPlan(type.name, modelId, attr.name);
  } else if (type.kind === "value") {
    plan = ctx.valuePlan(type.id, modelId, attr.name);
  } else {
    plan = modelPlan(ctx, type.id, effectiveDiscriminator(ctx.bundle.models[modelId], attr, modelId), attr, modelId);
  }
  const values = (attr as AttributeSpec & { readonly values?: readonly NeutralValue[] }).values;
  if (values !== undefined && values !== null) {
    if (type.kind === "model") {
      return fail({ reason: "invalid_document", ...where, location: "/values", detail: "enum values on a model type" });
    }
    plan = ctx.enumPlan(plan, values, modelId, attr.name);
  }
  return plan;
}

function modelPlan(ctx: PlanContext, id: ModelId, discriminator: Discriminator | undefined, attr: AttributeSpec, modelId: string): ElementPlan {
  const classOf = (target: ModelId, reason: "dangling_reference" | "unknown_discriminator"): string =>
    ctx.classNames.get(target) ??
    fail({ reason, model_id: modelId, attribute: attr.name, detail: `model ${target} is not in the bundle` });
  if (discriminator === undefined) {
    const name = classOf(id, "dangling_reference");
    return {
      ts: name,
      check: `rt.instanceOf(${name}, ${JSON.stringify(name)})`,
      literal: null,
    };
  }
  classOf(id, "dangling_reference");
  const targets = [...new Set(Object.values(discriminator.cases))].sort(compareBytes);
  if (targets.length === 0) {
    return fail({ reason: "unknown_discriminator", model_id: modelId, attribute: attr.name, detail: "no cases" });
  }
  const names = targets.map((target) => classOf(target, "unknown_discriminator"));
  return {
    ts: names.join(" | "),
    check:
      names.length === 1
        ? `rt.instanceOf(${names[0]}, ${JSON.stringify(names[0])})`
        : `rt.anyOf([${names.map((n) => `rt.instanceOf(${n}, ${JSON.stringify(n)})`).join(", ")}], ${JSON.stringify(names.join(" | "))})`,
    literal: null,
  };
}

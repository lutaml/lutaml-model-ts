import type { AttributeSpec, ModelDocument, ModelId } from "../contracts.js";
import { access, declName, fail } from "./names.js";
import { planAttribute } from "./plan.js";
import type { ElementPlan, PlanContext } from "./plan.js";

const ORDERED_MEMBER = "__lml_content";
const FORBIDDEN_MEMBERS = new Set(["constructor", "__proto__"]);

interface Member {
  readonly name: string;
  readonly prop: string;
  readonly initType: string;
  readonly fieldType: string;
  readonly omittable: boolean;
  readonly filler: string | null;
  readonly specLine: string | null;
}

function arrayOf(ts: string): string {
  return ts.includes(" | ") ? `readonly (${ts})[]` : `readonly ${ts}[]`;
}

function checkCollection(attr: AttributeSpec, modelId: string, location: string): void {
  const spec = attr.collection;
  if (spec === false) return;
  const ok =
    Number.isInteger(spec.min) && spec.min >= 0 &&
    (spec.max === null || (Number.isInteger(spec.max) && spec.max >= spec.min));
  if (!ok) {
    fail({ reason: "invalid_document", model_id: modelId, attribute: attr.name, location: location + "/collection", detail: "invalid collection bounds" });
  }
  if (spec.class !== undefined) {
    fail({
      reason: "unsupported_type",
      model_id: modelId,
      attribute: attr.name,
      location: location + "/collection/class",
      detail: `collection class ${spec.class} has no TypeScript binding contract`,
    });
  }
}

function defaultExpr(attr: AttributeSpec, plan: ElementPlan, modelId: string, location: string): string | null {
  if (!attr.default.present) return null;
  const value = attr.default.value;
  const reject = (detail: string): never =>
    fail({ reason: "non_serializable_default", model_id: modelId, attribute: attr.name, location: location + "/default", detail });
  if (value === null) {
    return attr.required ? reject("null default on a required attribute") : "null";
  }
  if (plan.literal === null) return reject("defaults of model types are not portable");
  if (attr.collection === false) return plan.literal(value, reject);
  if (!Array.isArray(value)) return reject("collection default must be an array");
  return `[${value.map((item) => (plan.literal as NonNullable<ElementPlan["literal"]>)(item, reject)).join(", ")}]`;
}

/** Fills members a sparse document may omit with their contract meaning. */
function normalized(attr: AttributeSpec): AttributeSpec {
  const sparse = attr as Partial<AttributeSpec> & Pick<AttributeSpec, "name" | "type">;
  return {
    ...attr,
    required: sparse.required ?? false,
    collection: sparse.collection ?? false,
    default: sparse.default ?? { present: false },
    initialize_empty: sparse.initialize_empty ?? false,
  };
}

function buildMember(ctx: PlanContext, source: AttributeSpec, modelId: string, location: string): Member {
  const attr = normalized(source);
  if (FORBIDDEN_MEMBERS.has(attr.name)) {
    fail({ reason: "reserved_member", model_id: modelId, attribute: attr.name, location: location + "/name" });
  }
  checkCollection(attr, modelId, location);
  if (attr.initialize_empty && attr.collection === false) {
    fail({ reason: "invalid_document", model_id: modelId, attribute: attr.name, location: location + "/initialize_empty", detail: "initialize_empty needs a collection" });
  }
  const plan = planAttribute(ctx, attr, modelId);
  const def = defaultExpr(attr, plan, modelId, location);
  const base = attr.collection === false ? plan.ts : arrayOf(plan.ts);
  const filler = def ?? (attr.initialize_empty ? "[]" : null);
  const omittable = !attr.required || filler !== null;
  const nullable = !attr.required;
  const fieldType = !nullable ? base : filler !== null ? `${base} | null` : `rt.Maybe<${base}>`;
  const initType = `${base}${nullable ? " | null" : ""}${omittable ? " | rt.Absent" : ""}`;
  const collection = attr.collection === false
    ? "null"
    : `{ min: ${attr.collection.min}, max: ${attr.collection.max === null ? "null" : attr.collection.max} }`;
  const specLine =
    `rt.attr(out, o, { name: ${JSON.stringify(attr.name)}, required: ${attr.required}, ` +
    `filled: ${filler !== null}, collection: ${collection}, item: ${plan.check} });`;
  return { name: attr.name, prop: declName(attr.name), initType, fieldType, omittable, filler, specLine };
}

function constructorAssign(m: Member): string {
  const src = `init${access(m.name)}`;
  const dst = `this${access(m.name)}`;
  if (!m.omittable) return `${dst} = ${src};`;
  if (m.filler === null) return `${dst} = ${src} === undefined ? rt.ABSENT : ${src};`;
  return `${dst} = ${src} === undefined || ${src} === rt.ABSENT ? ${m.filler} : ${src};`;
}

export function emitClass(ctx: PlanContext, className: string, modelId: ModelId, doc: ModelDocument): string {
  const members: Member[] = [];
  const seen = new Set<string>();
  doc.attributes.forEach((attr, index) => {
    const location = `/models/${modelId}/attributes/${index}`;
    if (attr.name === ORDERED_MEMBER) {
      fail({ reason: "reserved_member", model_id: modelId, attribute: attr.name, location });
    }
    if (seen.has(attr.name)) {
      fail({ reason: "duplicate_id", model_id: modelId, attribute: attr.name, location });
    }
    seen.add(attr.name);
    members.push(buildMember(ctx, attr, modelId, location));
  });
  const ordered = doc.ordered_content !== undefined;
  const mandatory = members.some((m) => !m.omittable);
  const filledAny = members.some((m) => m.filler !== null);
  const names = members.map((m) => m.name);
  if (ordered) names.push(ORDERED_MEMBER);

  const lines: string[] = [];
  lines.push(`export interface ${className}Init {`);
  for (const m of members) lines.push(`  readonly ${m.prop}${m.omittable ? "?" : ""}: ${m.initType};`);
  if (ordered) lines.push(`  readonly ${ORDERED_MEMBER}?: rt.Maybe<readonly rt.OrderedContentToken[]>;`);
  lines.push("}", "");
  lines.push(`export class ${className} {`);
  lines.push(`  static readonly modelId = ${JSON.stringify(modelId)};`);
  lines.push(`  static readonly memberNames: readonly string[] = ${JSON.stringify(names)};`);
  lines.push("");
  for (const m of members) lines.push(`  readonly ${m.prop}: ${m.fieldType};`);
  if (ordered) lines.push(`  readonly ${ORDERED_MEMBER}: rt.Maybe<readonly rt.OrderedContentToken[]>;`);
  lines.push("");
  lines.push(`  constructor(init: ${className}Init${mandatory ? "" : " = {}"}) {`);
  lines.push(`    const problems = ${className}.validate(init);`);
  lines.push(`    if (problems.length > 0) throw new rt.ValidationError(${className}.modelId, problems);`);
  for (const m of members) lines.push(`    ${constructorAssign(m)}`);
  if (ordered) {
    lines.push(`    this.${ORDERED_MEMBER} = init.${ORDERED_MEMBER} === undefined ? rt.ABSENT : init.${ORDERED_MEMBER};`);
  }
  if (filledAny) {
    lines.push(`    const effective = ${className}.validate(this);`);
    lines.push(`    if (effective.length > 0) throw new rt.ValidationError(${className}.modelId, effective);`);
  }
  lines.push("    Object.freeze(this);", "  }", "");
  lines.push("  /** Reports every violation of an init-like value without throwing. */");
  lines.push("  static validate(input: unknown): readonly rt.Violation[] {");
  lines.push("    const out: rt.Violation[] = [];");
  lines.push("    const o = rt.record(input, out);");
  lines.push("    if (o === null) return out;");
  lines.push(`    rt.knownMembers(o, ${className}.memberNames, out);`);
  for (const m of members) lines.push(`    ${m.specLine ?? ""}`);
  if (ordered) {
    lines.push(`    rt.orderedContent(out, o, ${JSON.stringify(ORDERED_MEMBER)}, ${JSON.stringify(doc.attributes.map((a) => a.name))});`);
  }
  lines.push("    return out;", "  }", "}", "");
  return lines.join("\n");
}

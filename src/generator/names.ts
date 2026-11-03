import { LmlError } from "../contracts.js";
import type { ErrorDetail } from "../contracts.js";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CONSTANT_SEGMENT = /^[A-Z][A-Za-z0-9_]*$/;

/** Names the generated files already use, plus globals the output relies on. */
const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  "ABSENT", "Absent", "Maybe", "Violation", "ViolationCode", "ValidationError",
  "MODELS", "ROOT_MODEL_IDS", "NeutralValue", "NeutralObject", "QName",
  "OrderedContentToken",
  "Array", "ReadonlyArray", "Object", "Uint8Array", "Error", "Symbol", "String",
  "Number", "Boolean", "BigInt", "Map", "Set", "Promise", "Date", "Function",
  "JSON", "Math", "Reflect", "Proxy", "Record", "Readonly", "Partial", "Omit",
  "Pick", "Exclude", "Extract", "NonNullable", "Infinity", "NaN", "RegExp",
]);

export function fail(info: ErrorDetail): never {
  throw new LmlError(info);
}

export function isIdentifier(text: string): boolean {
  return IDENT.test(text);
}

/** Property access text: `.name` when legal, otherwise `["name"]`. */
export function access(name: string): string {
  return isIdentifier(name) ? "." + name : "[" + JSON.stringify(name) + "]";
}

/** Declaration text for a property name. */
export function declName(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

/** Registry of every top-level name the generated `models.ts` declares. */
export class NameTable {
  private readonly owners = new Map<string, string>();

  claim(name: string, owner: string, modelId: string): string {
    if (RESERVED_TYPE_NAMES.has(name)) {
      return fail({
        reason: "invalid_document",
        model_id: modelId,
        detail: `target name ${name} is reserved by the generated output`,
      });
    }
    const existing = this.owners.get(name);
    if (existing !== undefined) {
      return fail({
        reason: "duplicate_id",
        model_id: modelId,
        detail: `target name ${name} for ${owner} collides with ${existing}`,
      });
    }
    this.owners.set(name, owner);
    return name;
  }
}

/** `Example::Node` + register -> `ExampleNode` (non-default register suffixed). */
export function targetClassName(model: string, register: string, modelId: string): string {
  const segments = model.split("::");
  for (const segment of segments) {
    if (!CONSTANT_SEGMENT.test(segment)) {
      return fail({
        reason: "invalid_document",
        model_id: modelId,
        location: "/model",
        detail: `model name ${JSON.stringify(model)} has no portable TypeScript name`,
      });
    }
  }
  const suffix = register === "default" ? "" : "_" + register.replace(/[^A-Za-z0-9_]/g, "_");
  return segments.join("") + suffix;
}

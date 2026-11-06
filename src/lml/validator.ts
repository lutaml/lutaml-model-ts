import type { ErrorCode } from "../contracts.js";
import { fail, pointer } from "./errors.js";
import { canonicalFloat } from "./float.js";
import { RawFloat, type Raw } from "./raw.js";

/** Frozen neutral tree: JSON scalars, arrays, plain objects (v1 may hold bigint/RawFloat). */
export type Tree = null | boolean | number | bigint | string | RawFloat | readonly Tree[] | TreeObject;
export interface TreeObject {
  readonly [key: string]: Tree;
}

export type Kind = "document" | "bundle" | "manifest";

export const BUILTIN_TYPES: readonly string[] = [
  "string", "token", "uri", "email", "hostname", "ip", "boolean", "integer",
  "decimal", "float", "rational", "date", "time", "date_time", "time_without_date",
  "duration", "qname", "base64_binary", "hex_binary", "symbol", "hash",
  "email_address", "ip_v4_address", "ip_v6_address", "uuid", "reference", "uri_reference", "date_with_timezone", "date_time_with_timezone", "day_time_duration", "year_month_duration",
  "positive_integer", "non_negative_integer",
];
/** Builtins whose present default is a JSON integer (Ruby DocumentValidator::INTEGER_TYPES). */
const INTEGER_TYPES: readonly string[] = ["integer", "positive_integer", "non_negative_integer"];
const UNSUPPORTED_BUILTINS = ["double"];
export const FORMATS: readonly string[] = ["xml", "json", "yaml", "toml"];
const NAMESPACE_MODES = ["inherit", "unqualified", "uri"];
const MANIFEST_TARGETS = ["ruby", "ts", "rust", "wasm"];
const XML_RULE_KINDS = ["attribute", "element", "content", "any_attribute", "sequence", "choice"];
const ANY_ATTRIBUTE_KEYS = ["kind", "to"];
const REGISTER_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const ORDERED_CONTENT_MEMBER = "__lml_content";
const FLAG_KEYS = ["required", "initialize_empty"];
const DOT_SEGMENTS = ["", ".", ".."];
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
/** Containers nest at most this deep (Ruby DocumentValidator::MAX_DEPTH; root is level 1). */
export const MAX_DEPTH = 100;
/** Attribute names become fields and accessors: identifiers only. */
const ATTRIBUTE_NAME = /^[a-z_][a-zA-Z0-9_]*$/;
/** Names a generated class cannot carry (Ruby RESERVED_ATTRIBUTE_NAMES, measured and pinned there). */
export const RESERVED_ATTRIBUTE_NAMES: readonly string[] = [
  "__id__", "__send__", "attribute_order", "class", "doctype", "element_order",
  "encoding", "extract_register_id", "import_declaration_plan", "initialize",
  "initialize_clone", "initialize_copy", "initialize_dup", "lutaml_register",
  "pending_plan_root_element", "prepare_instance_format_options",
  "public_send", "record_mutation", "to_format", "to_json", "to_xml", "to_yaml",
  "value_set_for", "xml_declaration", "xml_ns_prefixes",
];
const MAPPING_OBJECT_KEYS = ["root_mappings", "child_mappings"];
const XML_PREFIX = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const MODEL_KEYS = ["lml", "model", "register", "attributes", "mappings", "ordered_content"];
const ATTRIBUTE_KEYS = ["name", "type", "required", "collection", "default", "initialize_empty", "values", "discriminator"];
const RULE_KEYS = ["kind", "name", "key", "to", "namespace", "prefix", "cdata", "render", "discriminator", "members", "min", "max", "child_mappings", "root_mappings", "polymorphic_map"];
const FORMAT_KEYS = ["root", "namespace", "rules", "root_mappings", "child_mappings", "ordered", "mixed_content", "sequence"];
const COMPOSITOR_KINDS = ["sequence", "choice"];
const EXECUTABLE_RULE_KEYS = ["with", "custom_methods", "delegate", "transform", "proc", "lambda", "method", "callback"];
const BUNDLE_KEYS = ["lml_bundle", "roots", "models", "value_types", "capabilities", "provenance"];
const MANIFEST_KEYS = ["manifest", "lml_checksum", "schema_version", "generator_version", "target", "capabilities", "corpora", "files", "dependencies"];

type Obj = TreeObject;
const has = (node: Obj, key: string): boolean => Object.hasOwn(node, key);
const isObj = (node: Tree | undefined): node is Obj =>
  node !== null && typeof node === "object" && !Array.isArray(node) && !(node instanceof RawFloat);
const isArr = (node: Tree | undefined): node is readonly Tree[] => Array.isArray(node);
const isInt = (node: Tree | undefined): node is number => typeof node === "number" && Number.isInteger(node);
const strOrUndef = (v: Tree | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** Byte-order (UTF-8) comparison, as Ruby's String#<=>. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
const sorted = (list: readonly string[]): string[] => [...list].sort(compareBytes);

function describe(value: Tree | undefined): string {
  if (value instanceof RawFloat) return String(value.value);
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? "undefined";
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function wellFormed(text: string, at: string): void {
  if (LONE_SURROGATE.test(text)) fail("invalid_document", "string is not valid UTF-8", at);
}

/** Deep copy into a frozen neutral tree, rejecting what v2 does not allow. */
function neutral(node: Raw, at: string, legacy: boolean, depth = 0): Tree {
  if ((node instanceof Map || Array.isArray(node)) && depth >= MAX_DEPTH) {
    fail("invalid_document", `nesting deeper than ${MAX_DEPTH} levels`, at);
  }
  if (node instanceof Map) {
    const out: Record<string, Tree> = {};
    for (const [key, value] of node) {
      if (typeof key !== "string") fail("invalid_document", `non-string key ${String(key)}`, at);
      wellFormed(key, at);
      Object.defineProperty(out, key, {
        value: neutral(value, `${at}${pointer(key)}`, legacy, depth + 1),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return Object.freeze(out);
  }
  if (Array.isArray(node)) {
    return Object.freeze(node.map((item: Raw, i) => neutral(item, `${at}/${i}`, legacy, depth + 1)));
  }
  if (typeof node === "string") {
    wellFormed(node, at);
    return node;
  }
  if (typeof node === "number" || typeof node === "bigint") {
    if (!legacy && (typeof node === "bigint" || Math.abs(node) > MAX_SAFE_INTEGER)) {
      fail("invalid_document", "structural integer out of bounds", at);
    }
    return node;
  }
  if (node === null || typeof node === "boolean") return node;
  if (node instanceof RawFloat) {
    if (legacy) return node;
    return fail("invalid_document", "floats are not portable; use an exact string", at);
  }
  return fail("invalid_document", "unsupported value", at);
}

function expectObject(node: Tree | undefined, at: string): asserts node is Obj {
  if (!isObj(node)) fail("invalid_document", "expected an object", at);
}
function expectArray(node: Tree | undefined, at: string): asserts node is readonly Tree[] {
  if (!isArr(node)) fail("invalid_document", "expected an array", at);
}
function expectString(node: Tree | undefined, at: string): asserts node is string {
  if (typeof node !== "string" || node === "") fail("invalid_document", "expected a non-empty string", at);
}
function expectBool(node: Tree | undefined, at: string): asserts node is boolean {
  if (typeof node !== "boolean") fail("invalid_document", "expected a boolean", at);
}
function requireKeys(node: Obj, keys: readonly string[], at: string): void {
  for (const key of keys) {
    if (!has(node, key)) fail("invalid_document", `missing ${key}`, at + pointer(key));
  }
}
function onlyKeys(node: Obj, allowed: readonly string[], at: string, reason: ErrorCode = "invalid_document"): void {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) fail(reason, `unknown key ${key}`, at + pointer(key));
  }
}
function checkVersion(node: Obj, field: string, supported: readonly number[], at: string): void {
  if (!has(node, field)) fail("invalid_document", `missing ${field}`, at + pointer(field));
  const version = node[field];
  if (isInt(version) && supported.includes(version)) return;
  fail("unsupported_version",
    `${field} ${describe(version)} is not supported (supported: ${supported.join(", ")})`, at + pointer(field));
}

// -- documents ---------------------------------------------------------

function validateDocumentTree(node: Tree, at = ""): void {
  expectObject(node, at);
  checkVersion(node, "lml", [1, 2], at);
  if (node["lml"] === 1) documentV1(node, at);
  else modelV2(node, at);
}

function documentV1(node: Obj, at: string): void {
  expectString(node["model"], at + pointer("model"));
  const register = node["register"];
  if (has(node, "register") && register !== null && typeof register !== "string") {
    fail("invalid_document", "register must be a string", at + pointer("register"));
  }
  if (has(node, "attributes")) {
    const attributes = node["attributes"];
    expectArray(attributes, at + pointer("attributes"));
    attributes.forEach((attr, i) => expectObject(attr, `${at}/attributes/${i}`));
  }
  if (has(node, "mappings")) expectObject(node["mappings"], at + pointer("mappings"));
}

function modelV2(node: Obj, at: string, expectedId?: string): string {
  rejectExecutableFlags(node, at);
  onlyKeys(node, MODEL_KEYS, at);
  requireKeys(node, ["lml", "model", "register", "attributes"], at);
  const model = node["model"];
  expectString(model, at + pointer("model"));
  const register = node["register"];
  if (typeof register !== "string" || !REGISTER_PATTERN.test(register)) {
    fail("invalid_document", `register must match ${REGISTER_PATTERN.source}`, at + pointer("register"));
  }
  const id = `${model}@${register}`;
  if (expectedId !== undefined && expectedId !== id) {
    fail("invalid_document", `key ${expectedId} does not match model ID ${id}`, at, { model_id: id });
  }
  attributesV2(node["attributes"], at, id);
  if (has(node, "mappings")) mappingsV2(node["mappings"], at, id, node["attributes"]);
  orderedContent(node, at, id);
  return id;
}

function rejectExecutableFlags(node: Obj, at: string): void {
  const flags: readonly (readonly [string, ErrorCode])[] = [
    ["custom_initialize", "custom_initialize"],
    ["imperative_element_order", "imperative_element_order"],
  ];
  for (const [key, reason] of flags) {
    if (!has(node, key)) continue;
    const model = node["model"];
    // Ruby: `node["model"] && "#{model}@#{register}"`; nil/false model yields no ID.
    const modelId = model === null || model === undefined || model === false
      ? undefined
      : `${interpolate(model)}@${interpolate(node["register"])}`;
    fail(reason, `${key} models have no declarative equivalent`, at + pointer(key), { model_id: modelId });
  }
}
function interpolate(value: Tree | undefined): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : describe(value);
}

function attributesV2(attributes: Tree | undefined, at: string, id: string): void {
  expectArray(attributes, at + pointer("attributes"));
  const seen = new Set<string>();
  attributes.forEach((attr, i) => {
    const loc = `${at}/attributes/${i}`;
    expectObject(attr, loc);
    rejectLambdaDefault(attr, loc, id);
    onlyKeys(attr, ATTRIBUTE_KEYS, loc);
    requireKeys(attr, ["name", "type"], loc);
    const name = attr["name"];
    expectString(name, loc + pointer("name"));
    attributeName(name, loc + pointer("name"), id);
    if (name === ORDERED_CONTENT_MEMBER) {
      fail("reserved_member", `${name} is reserved for ordered content`, loc + pointer("name"),
        { model_id: id, attribute: name });
    }
    if (seen.has(name)) {
      fail("duplicate_id", `attribute ${name} declared twice`, loc + pointer("name"),
        { model_id: id, attribute: name });
    }
    seen.add(name);
    typeSpec(attr["type"], loc + pointer("type"), id, name);
    for (const flag of FLAG_KEYS) if (has(attr, flag)) expectBool(attr[flag], loc + pointer(flag));
    if (has(attr, "collection")) collection(attr["collection"], loc + pointer("collection"));
    if (has(attr, "default")) {
      defaultSpec(attr["default"], loc + pointer("default"), id, name);
      typedDefault(attr, loc, id, name);
    }
    floatDefault(attr, loc, id, name);
    if (has(attr, "values")) expectArray(attr["values"], loc + pointer("values"));
    if (has(attr, "discriminator")) discriminatorShape(attr["discriminator"], loc + pointer("discriminator"), id);
  });
}

function attributeName(name: string, at: string, id: string): void {
  if (!ATTRIBUTE_NAME.test(name)) {
    fail("invalid_document", `attribute name ${JSON.stringify(name)} must match \\A[a-z_][a-zA-Z0-9_]*\\z`, at,
      { model_id: id, attribute: name });
  }
  if (RESERVED_ATTRIBUTE_NAMES.includes(name)) {
    fail("reserved_member", `attribute name ${name} breaks Serializable (reserved attribute name)`, at,
      { model_id: id, attribute: name });
  }
}

function rejectLambdaDefault(attr: Obj, loc: string, id: string): void {
  const def = attr["default"];
  if (isObj(def) && (has(def, "lambda") || has(def, "proc"))) {
    fail("lambda_default", "executable defaults are not portable", loc + pointer("default"),
      { model_id: id, attribute: strOrUndef(attr["name"]) });
  }
}

function typeSpec(node: Tree | undefined, at: string, id: string, attribute: string): void {
  expectObject(node, at);
  const kind = node["kind"];
  if (kind === "builtin") {
    onlyKeys(node, ["kind", "name"], at);
    const name = node["name"];
    if (typeof name === "string" && BUILTIN_TYPES.includes(name)) return;
    const reason: ErrorCode = typeof name === "string" && UNSUPPORTED_BUILTINS.includes(name) ? "unsupported_type" : "unknown_type";
    fail(reason, `builtin type ${describe(name)}`, at + pointer("name"), { model_id: id, attribute });
  } else if (kind === "model" || kind === "value") {
    onlyKeys(node, ["kind", "id"], at);
    expectString(node["id"], at + pointer("id"));
  } else {
    fail("unknown_type", `type kind ${describe(kind)}`, at + pointer("kind"), { model_id: id, attribute });
  }
}

function collection(node: Tree | undefined, at: string): void {
  if (node === false) return;
  expectObject(node, at);
  onlyKeys(node, ["min", "max", "class"], at);
  requireKeys(node, ["min", "max"], at);
  const min = node["min"];
  const max = node["max"];
  if (!isInt(min) || min < 0) fail("invalid_document", "min must be a non-negative integer", at + pointer("min"));
  if (!(max === null || (isInt(max) && max >= min))) {
    fail("invalid_document", "max must be null or an integer >= min", at + pointer("max"));
  }
  if (has(node, "class")) expectString(node["class"], at + pointer("class"));
}

function defaultSpec(node: Tree | undefined, at: string, id: string, attribute: string): void {
  expectObject(node, at);
  onlyKeys(node, ["present", "value"], at);
  const present = node["present"];
  expectBool(present, at + pointer("present"));
  if (present) {
    if (!has(node, "value")) {
      fail("invalid_document", "present default needs a value", at + pointer("value"), { model_id: id, attribute });
    }
  } else if (has(node, "value")) {
    fail("invalid_document", "absent default carries no value", at + pointer("value"), { model_id: id, attribute });
  }
}

// The one JSON shape a present default takes for a builtin type, identical to Ruby
// DocumentValidator.default_shape? (and the exporter's portable_scalar): integer is a
// JSON integer, boolean a JSON boolean, hash an object, every other builtin (decimal,
// rational, date, qname, ...) its string spelling. float has its own canonical-string
// rule (floatDefault); a non-builtin kind is not shape-checked.
function defaultShape(kind: string, item: Tree | undefined): boolean {
  if (item === null || item === undefined || !BUILTIN_TYPES.includes(kind)) return true;
  if (INTEGER_TYPES.includes(kind)) return typeof item === "number" && Number.isInteger(item);
  switch (kind) {
    case "boolean": return typeof item === "boolean";
    case "hash": return isObj(item);
    case "float": return true;
    default: return typeof item === "string";
  }
}

/** A present default on a builtin type matches that type (collection items each). */
function typedDefault(attr: Obj, loc: string, id: string, name: string): void {
  const type = attr["type"];
  const def = attr["default"];
  if (!isObj(type) || type["kind"] !== "builtin" || !isObj(def) || def["present"] !== true) return;
  const kind = type["name"];
  if (typeof kind !== "string" || kind === "float") return; // floatDefault owns the wire string rule
  const value = def["value"];
  const items = attr["collection"] !== undefined && attr["collection"] !== false && Array.isArray(value) ? value : [value];
  if (items.every((item) => defaultShape(kind, item))) return;
  fail("non_serializable_default", `default ${JSON.stringify(value)} is not a ${kind}`, loc + pointer("default", "value"),
    { model_id: id, attribute: name });
}

/** A float default is a canonical float string (never a JSON number). */
function floatDefault(attr: Obj, loc: string, id: string, name: string): void {
  const type = attr["type"];
  const def = attr["default"];
  if (!isObj(type) || type["kind"] !== "builtin" || type["name"] !== "float") return;
  if (!isObj(def) || def["present"] !== true) return;
  if (canonicalFloat(def["value"])) return;
  fail("invalid_document", "float default must be a canonical float string", loc + pointer("default", "value"),
    { model_id: id, attribute: name });
}

function discriminatorShape(node: Tree | undefined, at: string, id: string): void {
  expectObject(node, at);
  onlyKeys(node, ["attribute", "cases"], at);
  requireKeys(node, ["attribute", "cases"], at);
  expectString(node["attribute"], at + pointer("attribute"));
  const cases = node["cases"];
  expectObject(cases, at + pointer("cases"));
  if (Object.keys(cases).length === 0) fail("unknown_discriminator", "no cases", at + pointer("cases"), { model_id: id });
  for (const [wire, target] of Object.entries(cases)) expectString(target, `${at}/cases${pointer(wire)}`);
}

function mappingsV2(mappings: Tree | undefined, at: string, id: string, attributes: Tree | undefined): void {
  expectObject(mappings, at + pointer("mappings"));
  for (const [format, mapping] of Object.entries(mappings)) {
    const loc = `${at}/mappings${pointer(format)}`;
    if (!FORMATS.includes(format)) fail("unsupported_format", `format ${format}`, loc, { model_id: id, format });
    expectObject(mapping, loc);
    onlyKeys(mapping, FORMAT_KEYS, loc, "unsupported_mapping");
    if (has(mapping, "namespace")) namespace(mapping["namespace"], `${loc}/namespace`, id, format);
    if (has(mapping, "root")) mappingRoot(mapping["root"], `${loc}/root`, id, format);
    for (const key of MAPPING_OBJECT_KEYS) if (has(mapping, key)) expectObject(mapping[key], `${loc}/${key}`);
    mappingFlags(mapping, loc, id, format);
    if (!has(mapping, "rules")) continue;
    const rules = mapping["rules"];
    expectArray(rules, `${loc}/rules`);
    rules.forEach((rule, i) => ruleV2(rule, `${loc}/rules/${i}`, id, format));
    anyAttributeRules(rules, loc, id, format, attributes);
  }
}

/**
 * any_attribute (map_all_attributes): xml only, top level only (compositors refuse it),
 * at most one per mapping, `to` a declared non-collection builtin hash attribute.
 * Ruby does not check its position in the list (the exporter always emits it last).
 */
function anyAttributeRules(rules: readonly Tree[], loc: string, id: string, format: string, attributes: Tree | undefined): void {
  const found: number[] = [];
  rules.forEach((rule, i) => { if (isObj(rule) && rule["kind"] === "any_attribute") found.push(i); });
  const first = found[0];
  if (first === undefined) return;
  if (format !== "xml") fail("unsupported_mapping", "any_attribute is xml only", `${loc}/rules/${first}`, { model_id: id, format });
  const second = found[1];
  if (second !== undefined) {
    fail("unsupported_mapping", "at most one any_attribute rule per mapping", `${loc}/rules/${second}`, { model_id: id, format });
  }
  const at = `${loc}/rules/${first}`;
  const rule = rules[first] as Obj;
  onlyKeys(rule, ANY_ATTRIBUTE_KEYS, at, "unsupported_mapping");
  const to = rule["to"];
  expectString(to, at + pointer("to"));
  const target = (isArr(attributes) ? attributes : []).find((a): a is Obj => isObj(a) && a["name"] === to);
  if (target === undefined) {
    fail("dangling_reference", `any_attribute \`to\` ${describe(to)} is not an attribute of the model`, at + pointer("to"), { model_id: id, format });
  }
  const type = target["type"];
  if (isObj(type) && type["kind"] === "builtin" && type["name"] === "hash" && !target["collection"]) return;
  fail("unsupported_mapping", `any_attribute \`to\` ${describe(to)} must be a non-collection hash attribute`, at + pointer("to"), { model_id: id, format });
}

function mappingRoot(node: Tree | undefined, at: string, id: string, format: string): void {
  expectObject(node, at);
  if (has(node, "element")) expectString(node["element"], at + pointer("element"));
  if (has(node, "mixed") && typeof node["mixed"] !== "boolean") {
    fail("unsupported_mapping", "root mixed must be true or false", at + pointer("mixed"), { model_id: id, format });
  }
}

/** ordered / mixed_content are booleans; sequence is an array of compositors (xml only). */
function mappingFlags(mapping: Obj, loc: string, id: string, format: string): void {
  for (const flag of ["ordered", "mixed_content"]) {
    if (has(mapping, flag) && typeof mapping[flag] !== "boolean") {
      fail("unsupported_mapping", `${flag} must be true or false`, `${loc}/${flag}`, { model_id: id, format });
    }
  }
  if (!has(mapping, "sequence")) return;
  if (format !== "xml") fail("unsupported_mapping", "sequence is xml only", `${loc}/sequence`, { model_id: id, format });
  const groups = mapping["sequence"];
  expectArray(groups, `${loc}/sequence`);
  groups.forEach((group, i) => compositorV2(group, `${loc}/sequence/${i}`, id, format));
}

function compositorV2(node: Tree | undefined, at: string, id: string, format: string): void {
  ruleV2(node, at, id, format);
  const group = node as Obj;
  const kind = group["kind"];
  if (!(typeof kind === "string" && COMPOSITOR_KINDS.includes(kind))) {
    fail("unsupported_mapping", "expected a sequence or choice", at + pointer("kind"), { model_id: id, format });
  }
  const members = group["members"];
  expectArray(members, `${at}/members`);
  members.forEach((member, i) => {
    const loc = `${at}/members/${i}`;
    expectObject(member, loc);
    const mk = member["kind"];
    if (mk === "any_attribute") {
      fail("unsupported_mapping", "any_attribute is not allowed inside a compositor", loc + pointer("kind"), { model_id: id, format });
    }
    if (typeof mk === "string" && COMPOSITOR_KINDS.includes(mk)) compositorV2(member, loc, id, format);
    else ruleV2(member, loc, id, format);
  });
}

function ruleV2(rule: Tree | undefined, at: string, id: string, format: string): void {
  expectObject(rule, at);
  for (const key of Object.keys(rule)) {
    if (EXECUTABLE_RULE_KEYS.includes(key)) {
      fail("unsupported_mapping", `executable rule key ${key}`, at + pointer(key), { model_id: id, format });
    }
  }
  onlyKeys(rule, RULE_KEYS, at, "unsupported_mapping");
  const kind = rule["kind"];
  if (format === "xml" && has(rule, "kind") && !(typeof kind === "string" && XML_RULE_KINDS.includes(kind))) {
    fail("unsupported_mapping", `rule kind ${describe(kind)}`, at + pointer("kind"), { model_id: id, format });
  }
  if (has(rule, "namespace")) namespace(rule["namespace"], `${at}/namespace`, id, format);
  for (const key of MAPPING_OBJECT_KEYS) if (has(rule, key)) expectObject(rule[key], `${at}/${key}`);
  if (has(rule, "cdata")) expectBool(rule["cdata"], `${at}/cdata`);
  if (has(rule, "polymorphic_map")) {
    const map = rule["polymorphic_map"];
    expectObject(map, `${at}/polymorphic_map`);
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== "string" || v === "") fail("invalid_document", "expected a non-empty string", `${at}/polymorphic_map${pointer(k)}`);
    }
  }
  if (has(rule, "name")) expectArray(rule["name"], `${at}/name`);
  if (has(rule, "key")) expectArray(rule["key"], `${at}/key`);
  if (has(rule, "render")) render(rule["render"], `${at}/render`, id, format);
  if (has(rule, "discriminator")) discriminatorShape(rule["discriminator"], `${at}/discriminator`, id);
}

function namespace(node: Tree | undefined, at: string, id: string, format: string): void {
  expectObject(node, at);
  const mode = node["mode"];
  if (!(typeof mode === "string" && NAMESPACE_MODES.includes(mode))) {
    fail("unsupported_mapping", `namespace mode ${describe(mode)}`, at + pointer("mode"), { model_id: id, format });
  }
  onlyKeys(node, ["mode", "uri", "prefix"], at, "unsupported_mapping");
  if (has(node, "prefix")) prefix(node["prefix"], at + pointer("prefix"));
  if (mode === "uri") expectString(node["uri"], at + pointer("uri"));
  else if (has(node, "uri") || has(node, "prefix")) {
    fail("unsupported_mapping", "uri/prefix only with mode uri", at, { model_id: id, format });
  }
}

function prefix(node: Tree | undefined, at: string): void {
  if (typeof node === "string" && XML_PREFIX.test(node)) return;
  fail("invalid_document", `prefix must match ${"\\A[A-Za-z_][A-Za-z0-9_.-]*\\z"}`, at);
}

function render(node: Tree | undefined, at: string, id: string, format: string): void {
  expectObject(node, at);
  onlyKeys(node, ["nil", "empty", "default"], at, "unsupported_mapping");
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string" || typeof value === "boolean") continue;
    fail("unsupported_mapping", `render policy ${key}`, at + pointer(key), { model_id: id, format });
  }
}

function orderedContent(node: Obj, at: string, id: string): void {
  if (!has(node, "ordered_content")) return;
  const content = node["ordered_content"];
  const valid = isObj(content) && sorted(Object.keys(content)).join(",") === "member,version" &&
    content["member"] === ORDERED_CONTENT_MEMBER && content["version"] === 1;
  if (!valid) {
    fail("invalid_ordered_content", `expected {member: ${ORDERED_CONTENT_MEMBER}, version: 1}`,
      at + pointer("ordered_content"), { model_id: id });
  }
}

// -- bundles -----------------------------------------------------------

function validateBundleTree(node: Tree): void {
  expectObject(node, "");
  checkVersion(node, "lml_bundle", [1], "");
  onlyKeys(node, BUNDLE_KEYS, "");
  requireKeys(node, ["roots", "models", "value_types", "capabilities"], "");
  const { roots, models, value_types: values, capabilities: caps } = node;
  expectObject(models, "/models");
  expectObject(values, "/value_types");
  const rootList = sortedUniqueStrings(roots, "/roots");
  const capList = sortedUniqueStrings(caps, "/capabilities");
  if (has(node, "provenance")) expectObject(node["provenance"], "/provenance");

  for (const [vid, definition] of Object.entries(values)) valueType(vid, definition, `/value_types${pointer(vid)}`);
  for (const [mid, doc] of Object.entries(models)) {
    const loc = `/models${pointer(mid)}`;
    expectObject(doc, loc);
    checkVersion(doc, "lml", [2], loc);
    modelV2(doc, loc, mid);
    const mappings = doc["mappings"];
    for (const format of isObj(mappings) ? Object.keys(mappings) : []) {
      if (capList.includes(format)) continue;
      fail("capability_missing", `format ${format} is not in capabilities`,
        `${loc}/mappings${pointer(format)}`, { model_id: mid, format });
    }
  }
  rootList.forEach((root, i) => {
    if (!has(models, root)) fail("dangling_reference", `root ${root} is not a bundled model`, `/roots/${i}`, { model_id: root });
  });
  checkGraph(models, values);
}

function sortedUniqueStrings(node: Tree | undefined, at: string): string[] {
  expectArray(node, at);
  node.forEach((item, i) => expectString(item, `${at}/${i}`));
  const list = node as readonly string[];
  const dup = list.find((item, i) => list.indexOf(item) !== i);
  if (dup !== undefined) fail("duplicate_id", `${dup} listed twice`, at);
  const ordered = sorted(list);
  if (list.some((item, i) => item !== ordered[i])) fail("invalid_document", "must be sorted", at);
  return [...list];
}

function valueType(vid: string, definition: Tree, at: string): void {
  expectObject(definition, at);
  onlyKeys(definition, ["base", "facets"], at);
  requireKeys(definition, ["base", "facets"], at);
  expectObject(definition["facets"], `${at}/facets`);
  const base = definition["base"];
  if (typeof base === "string" && BUILTIN_TYPES.includes(base)) return;
  const reason: ErrorCode = typeof base === "string" && UNSUPPORTED_BUILTINS.includes(base) ? "unsupported_type" : "unknown_type";
  fail(reason, `value type ${vid} base ${describe(base)}`, `${at}/base`);
}

function checkGraph(models: Obj, values: Obj): void {
  for (const [mid, docTree] of Object.entries(models)) {
    const doc = docTree as Obj;
    (doc["attributes"] as readonly Obj[]).forEach((attr, i) => {
      const loc = `/models${pointer(mid)}/attributes/${i}`;
      checkTypeRef(attr["type"] as Obj, models, values, `${loc}/type`, mid);
      if (attr["discriminator"]) checkDiscriminator(attr["discriminator"] as Obj, models, `${loc}/discriminator`, mid);
    });
    for (const [format, mapping] of Object.entries((doc["mappings"] ?? {}) as Obj)) {
      const rules = ((mapping as Obj)["rules"] ?? []) as readonly Obj[];
      rules.forEach((rule, i) => {
        if (!rule["discriminator"]) return;
        checkDiscriminator(rule["discriminator"] as Obj, models,
          `/models${pointer(mid)}/mappings${pointer(format)}/rules/${i}/discriminator`, mid);
      });
    }
  }
}

function checkTypeRef(ref: Obj, models: Obj, values: Obj, at: string, mid: string): void {
  const kind = ref["kind"];
  const table = kind === "model" ? models : kind === "value" ? values : undefined;
  if (table === undefined || has(table, ref["id"] as string)) return;
  fail("dangling_reference", `${String(kind)} ${String(ref["id"])} is not in the bundle`, `${at}/id`, { model_id: mid });
}

function checkDiscriminator(disc: Obj, models: Obj, at: string, mid: string): void {
  for (const [wire, target] of Object.entries(disc["cases"] as Obj)) {
    const targetId = target as string;
    if (!has(models, targetId)) {
      fail("dangling_reference", `case ${wire} targets ${targetId}`, `${at}/cases${pointer(wire)}`, { model_id: mid });
    }
    const attrs = (models[targetId] as Obj)["attributes"] as readonly Obj[];
    if (attrs.some((a) => a["name"] === disc["attribute"])) continue;
    fail("unknown_discriminator", `${targetId} has no attribute ${String(disc["attribute"])}`, `${at}/attribute`, { model_id: mid });
  }
}

// -- manifests ---------------------------------------------------------

function validateManifestTree(node: Tree): void {
  expectObject(node, "");
  checkVersion(node, "manifest", [1], "");
  onlyKeys(node, MANIFEST_KEYS, "");
  requireKeys(node, MANIFEST_KEYS, "");
  digest(node["lml_checksum"], "/lml_checksum");
  checkVersion(node, "schema_version", [2], "");
  expectString(node["generator_version"], "/generator_version");
  const target = node["target"];
  if (!(typeof target === "string" && MANIFEST_TARGETS.includes(target))) {
    fail("invalid_document", `target ${describe(target)}`, "/target");
  }
  sortedUniqueStrings(node["capabilities"], "/capabilities");
  const corpora = node["corpora"];
  expectArray(corpora, "/corpora");
  corpora.forEach((c, i) => corpus(c, `/corpora/${i}`));
  pinnedList(node["files"], "/files", "path", true);
  pinnedList(node["dependencies"], "/dependencies", "name", false, "revision");
}

function digest(node: Tree | undefined, at: string): void {
  if (typeof node === "string" && SHA256_PATTERN.test(node)) return;
  fail("invalid_document", "expected sha256:<64 lowercase hex>", at);
}

function corpus(node: Tree | undefined, at: string): void {
  expectObject(node, at);
  onlyKeys(node, ["generation", "sha256"], at);
  requireKeys(node, ["generation", "sha256"], at);
  digest(node["sha256"], `${at}/sha256`);
}

function pinnedList(list: Tree | undefined, at: string, idKey: string, relative: boolean, extra?: string): void {
  expectArray(list, at);
  const keys = [idKey, ...(extra ? [extra] : []), "sha256"];
  const ids = list.map((entry, i) => {
    const loc = `${at}/${i}`;
    expectObject(entry, loc);
    onlyKeys(entry, keys, loc);
    requireKeys(entry, keys, loc);
    expectString(entry[idKey], `${loc}/${idKey}`);
    if (extra) expectString(entry[extra], `${loc}/${extra}`);
    digest(entry["sha256"], `${loc}/sha256`);
    if (relative) safePath(entry[idKey] as string, `${loc}/${idKey}`);
    return entry[idKey] as string;
  });
  if (new Set(ids).size !== ids.length) fail("duplicate_id", `duplicate ${idKey}`, at);
  const ordered = sorted(ids);
  if (ids.some((id, i) => id !== ordered[i])) fail("invalid_document", `must be sorted by ${idKey}`, at);
}

function safePath(path: string, at: string): void {
  const unsafe = path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((s) => DOT_SEGMENTS.includes(s));
  if (unsafe) fail("invalid_document", "path must be relative without traversal", at);
}

// -- entry -------------------------------------------------------------

/** Ruby `hash["lml"] == 1`: integer 1 or float 1.0. */
function isLegacyOne(v: Raw | undefined): boolean {
  return v === 1 || (v instanceof RawFloat && v.value === 1);
}

/** Validates and deep-freezes `raw`; throws LmlError on the first violation. */
export function validateRaw(raw: Raw, kind: Kind): Tree {
  const legacy = kind === "document" && raw instanceof Map && isLegacyOne(raw.get("lml") as Raw | undefined);
  const tree = neutral(raw, "", legacy);
  if (kind === "document") validateDocumentTree(tree);
  else if (kind === "bundle") validateBundleTree(tree);
  else validateManifestTree(tree);
  return tree;
}

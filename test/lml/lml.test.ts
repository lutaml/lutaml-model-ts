import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { ERROR_CODES, LmlError, type ErrorCode, type SchemaFormat } from "../../src/contracts.js";
import {
  bundleCanonicalJson,
  bundleChecksum,
  loadBundle,
  loadDocument,
  loadManifest,
  modelChecksum,
  rubyFloat,
} from "../../src/lml/index.js";
import { BUILTIN_TYPES, FORMATS } from "../../src/lml/validator.js";

const dir = new URL("./fixtures/", import.meta.url);
const text = (name: string): string => readFileSync(new URL(name, dir), "utf8");
const json = (name: string): any => JSON.parse(text(name));
const bytes = (value: unknown, format: SchemaFormat = "json"): Uint8Array =>
  new TextEncoder().encode(format === "json" ? JSON.stringify(value) : YAML.stringify(value));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Loader = (b: Uint8Array, f: SchemaFormat) => unknown;
function refusal(load: Loader, value: unknown, format: SchemaFormat = "json"): LmlError | undefined {
  try {
    load(bytes(value, format), format);
  } catch (error) {
    if (error instanceof LmlError) return error;
    throw error;
  }
  return undefined;
}
const where = (e: LmlError | undefined): [ErrorCode | undefined, string | undefined] => [e?.info.reason, e?.info.location];

// Golden values produced by the Ruby reference on lutaml-model
// issue-1033/wave1-contract-exporter-ordered-content (Document#checksum,
// Bundle#checksum, Bundle#model_checksum, Ruby json 3.1.0).
const V1_UNIT = "sha256:04b66d5ff963c422758bce40377498c7f466645c215f19bccc5936d78468911b";
const V2_NODE = "sha256:b4b3f994b6069fe2982f8de18a40df0f044d85d000912dc97044201c7785bf43";
const BUNDLE = "sha256:957545cf4beebea6534d3187a05970d691dd9ad77c287331774cd364b47f2a9f";
const BUNDLE_WITH_PROVENANCE = "sha256:3dd25bbe99b3831b545a6c419c752807dc6d7321e8751b31830bec4b80fc59f8";
const V1_ORDER = "sha256:c2ce2e6de6504e4c59ef27a774d96ad030725d9715f3ee6b02859e127d281572";
const V2_ESCAPES = "sha256:aa513f10d410ce13571d4ff3f4fa1b00be226b05b1b3bab35bbf3fbc49f53746";
const V1_ORDER_CANONICAL =
  '{"lml":1,"model":"M","attributes":[{"default":1.0},{"default":0.1},{"default":100.0},{"default":1e+16},{"default":0.0001},{"default":-0.0},{"d":"\u007f\\u001f\u2028é/\\\\\\"😀"}],"mappings":{"b":1,"10":2,"9":3,"a":{"z":1,"y":2}}}';

describe("canonical bytes and checksums", () => {
  it("v1 keeps source order and matches the pinned canonical bytes and checksum (JSON and YAML)", () => {
    const doc = json("v1_unit.json");
    for (const format of ["json", "yaml"] as const) {
      const loaded = loadDocument(bytes(doc, format), format);
      expect(loaded.version).toBe(1);
      expect(loaded.canonicalJson).toBe(text("v1_unit.canonical.json"));
      expect(loaded.checksum).toBe(V1_UNIT);
    }
  });

  it("v2 is key-sorted and matches the pinned canonical file and checksum (JSON and YAML)", () => {
    const doc = json("v2_node.json");
    for (const format of ["json", "yaml"] as const) {
      const loaded = loadDocument(bytes(doc, format), format);
      expect(loaded.version).toBe(2);
      expect(loaded.canonicalJson).toBe(text("v2_node.canonical.json"));
      expect(loaded.checksum).toBe(V2_NODE);
      expect(loaded.checksum).toBe(`sha256:${createHash("sha256").update(text("v2_node.canonical.json")).digest("hex")}`);
    }
  });

  it("v2 checksum ignores key order", () => {
    const doc = json("v2_node.json");
    const shuffled = Object.fromEntries(Object.entries(doc).reverse());
    expect(loadDocument(bytes(shuffled), "json").checksum).toBe(V2_NODE);
  });

  it("v1 canonical form is never sorted, keeps integer-like keys in source order, drops unknown keys, and prints floats as Ruby does", () => {
    const loaded = loadDocument(new TextEncoder().encode(text("v1_legacy_order.json")), "json");
    expect(loaded.canonicalJson).toBe(V1_ORDER_CANONICAL);
    expect(loaded.checksum).toBe(V1_ORDER);
  });

  it("v2 escapes control characters like Ruby and sorts keys by UTF-8 bytes", () => {
    const loaded = loadDocument(new TextEncoder().encode(text("v2_escapes.json")), "json");
    expect(loaded.checksum).toBe(V2_ESCAPES);
    expect(loaded.canonicalJson).toContain('"value":"\u007f\\u001f\u2028é/\\\\\\"😀\\t\\n"');
    expect(loaded.canonicalJson).toContain('"rules":[{"key":["10"]');
  });

  it("bundle checksum excludes provenance; canonical JSON includes it; model checksum equals the document checksum", () => {
    const bundle = loadBundle(bytes(json("bundle.json")), "json");
    expect(bundleChecksum(bundle)).toBe(BUNDLE);
    const withProvenance = bundleCanonicalJson(bundle);
    expect(withProvenance).toContain('"provenance":{"source_revision":"SOURCE_SHA"}');
    expect(`sha256:${createHash("sha256").update(withProvenance).digest("hex")}`).toBe(BUNDLE_WITH_PROVENANCE);
    expect(modelChecksum(bundle, "Example::Node@default")).toBe(V2_NODE);
    const { provenance: _drop, ...plain } = json("bundle.json");
    expect(bundleChecksum(loadBundle(bytes(plain), "json"))).toBe(BUNDLE);
  });

  it("loads the bundle identically from YAML", () => {
    const fromYaml = loadBundle(bytes(json("bundle.json"), "yaml"), "yaml");
    expect(bundleChecksum(fromYaml)).toBe(BUNDLE);
    expect(fromYaml).toEqual(loadBundle(bytes(json("bundle.json")), "json"));
  });

  it("formats floats exactly as Ruby json 3.1 does", () => {
    const table: [number, string][] = [
      [1, "1.0"], [100, "100.0"], [0.1, "0.1"], [1e14, "100000000000000.0"], [1e15, "1e+15"],
      [1.5e16, "1.5e+16"], [1234567890123456, "1.234567890123456e+15"], [123456789012345, "123456789012345.0"],
      [1e-9, "0.000000001"], [1.5e-9, "0.0000000015"], [1e-10, "1e-10"], [1.5e300, "1.5e+300"],
      [5e-324, "5e-324"], [-1.5e-7, "-0.00000015"], [0.1 + 0.2, "0.30000000000000004"], [-0, "-0.0"],
    ];
    for (const [value, expected] of table) expect(rubyFloat(value), String(value)).toBe(expected);
  });
});

describe("accepted shapes", () => {
  it("returns deeply frozen trees and keeps v1 unknown keys out of v2", () => {
    const loaded = loadDocument(bytes(json("v2_node.json")), "json");
    expect(Object.isFrozen(loaded.document)).toBe(true);
    expect(Object.isFrozen((loaded.document as any).attributes[0].type)).toBe(true);
    expect(refusal(loadDocument, { ...json("v1_unit.json"), extra: 1 })).toBeUndefined();
    expect(refusal(loadDocument, { ...json("v2_node.json"), extra: 1 })?.info.reason).toBe("invalid_document");
  });

  it("accepts the manifest fixture", () => {
    expect(loadManifest(bytes(json("manifest.json")), "json").target).toBe("ts");
  });

  it("keeps a __proto__ key as data", () => {
    const doc = new TextEncoder().encode('{"lml":1,"model":"M","mappings":{"__proto__":{"x":1}}}');
    const loaded = loadDocument(doc, "json");
    expect(Object.keys((loaded.document as any).mappings)).toEqual(["__proto__"]);
    expect(({} as any).x).toBeUndefined();
  });
});

describe("version handling", () => {
  it("refuses unknown versions instead of rewriting them", () => {
    expect(where(refusal(loadDocument, { ...json("v2_node.json"), lml: 999 }))).toEqual(["unsupported_version", "/lml"]);
    expect(refusal(loadBundle, { ...json("bundle.json"), lml_bundle: 2 })?.info.reason).toBe("unsupported_version");
    expect(refusal(loadManifest, { ...json("manifest.json"), manifest: 2 })?.info.reason).toBe("unsupported_version");
    expect(refusal(loadManifest, { ...json("manifest.json"), schema_version: 3 })?.info.reason).toBe("unsupported_version");
  });

  it("refuses a v1 document inside a v2 bundle", () => {
    const b = copy(json("bundle.json"));
    b.models["Example::Node@default"].lml = 1;
    expect(refusal(loadBundle, b)?.info.reason).toBe("unsupported_version");
  });

  it("refuses v1 with a missing model", () => {
    expect(refusal(loadDocument, { lml: 1 })?.info.reason).toBe("invalid_document");
  });
});

describe("model errors (mirrors the Ruby validator spec)", () => {
  const withAttribute = (): any => {
    const doc = copy(json("v2_node.json"));
    doc.attributes.push({ name: "extra", type: { kind: "builtin", name: "string" } });
    return doc;
  };
  const cases: Record<string, [(d: any) => void, ErrorCode, string]> = {
    "lambda default": [(d) => { d.attributes[1].default = { lambda: "-> { 1 }" }; }, "lambda_default", "/attributes/1/default"],
    "present default without value": [(d) => { d.attributes[1].default = { present: true }; }, "invalid_document", "/attributes/1/default/value"],
    "custom initialize": [(d) => { d.custom_initialize = true; }, "custom_initialize", "/custom_initialize"],
    "imperative order": [(d) => { d.imperative_element_order = true; }, "imperative_element_order", "/imperative_element_order"],
    "unknown builtin type": [(d) => { d.attributes[1].type = { kind: "builtin", name: "nope" }; }, "unknown_type", "/attributes/1/type/name"],
    "unknown type kind": [(d) => { d.attributes[1].type = { kind: "weird" }; }, "unknown_type", "/attributes/1/type/kind"],
    "float type": [(d) => { d.attributes[1].type = { kind: "builtin", name: "float" }; }, "unsupported_type", "/attributes/1/type/name"],
    "duplicate attribute": [(d) => { d.attributes[1].name = "children"; }, "duplicate_id", "/attributes/1/name"],
    "reserved member": [(d) => { d.attributes[1].name = "__lml_content"; }, "reserved_member", "/attributes/1/name"],
    "unknown format": [(d) => { d.mappings.csv = {}; }, "unsupported_format", "/mappings/csv"],
    "executable rule": [(d) => { d.mappings.xml.rules[0].with = { to: "x" }; }, "unsupported_mapping", "/mappings/xml/rules/0/with"],
    "unknown rule key": [(d) => { d.mappings.xml.rules[0].mystery = 1; }, "unsupported_mapping", "/mappings/xml/rules/0/mystery"],
    "unknown namespace mode": [(d) => { d.mappings.xml.namespace = { mode: "guess" }; }, "unsupported_mapping", "/mappings/xml/namespace/mode"],
    "bad ordered content": [(d) => { d.ordered_content = { member: "other", version: 1 }; }, "invalid_ordered_content", "/ordered_content"],
    "float in a value": [(d) => { d.attributes[1].default = { present: true, value: 1.5 }; }, "invalid_document", "/attributes/1/default/value"],
    "integral float in a value": [(d) => { d.attributes[1].default = { present: true, value: 1.0 }; }, "invalid_document", "/attributes/1/default/value"],
    "oversized integer": [(d) => { d.attributes[1].default = { present: true, value: 2 ** 60 }; }, "invalid_document", "/attributes/1/default/value"],
    "invalid register": [(d) => { d.register = "has space"; }, "invalid_document", "/register"],
  };
  for (const [name, [mutate, code, location]] of Object.entries(cases)) {
    for (const format of ["json", "yaml"] as const) {
      it(`refuses ${name} with ${code} at ${location} (${format})`, () => {
        const doc = withAttribute();
        mutate(doc);
        // JSON.stringify prints 1.0 as 1, so the integral-float case needs literal source text.
        const input = name === "integral float in a value"
          ? new TextEncoder().encode(new TextDecoder().decode(bytes(doc, format)).replace(/("value":|value: )1(?=\}|\n)/, "$11.0"))
          : bytes(doc, format);
        let error: LmlError | undefined;
        try { loadDocument(input, format); } catch (e) { error = e as LmlError; }
        expect(where(error)).toEqual([code, location]);
        if (["lambda_default", "reserved_member", "duplicate_id"].includes(code)) {
          expect(error?.info.model_id).toBe("Example::Node@default");
        }
      });
    }
  }

  it("refuses an oversized integer written in source text exactly (beyond 2**53)", () => {
    const src = JSON.stringify(withAttribute()).replace('"name":"extra"', '"name":"extra","default":{"present":true,"value":9007199254740993}');
    expect(() => loadDocument(new TextEncoder().encode(src), "json")).toThrow(/structural integer out of bounds/);
  });

  it("uses only the agreed error codes", () => {
    expect(ERROR_CODES).toHaveLength(21);
    expect(BUILTIN_TYPES).toHaveLength(20);
    expect(FORMATS).toEqual(["xml", "json", "yaml", "toml"]);
  });
});

describe("bundle graph", () => {
  const bundle = (): any => copy(json("bundle.json"));
  const node = "Example::Node@default";

  it("refuses a dangling type reference", () => {
    const b = bundle();
    b.models[node].attributes[0].type.id = "Missing@default";
    expect(where(refusal(loadBundle, b))).toEqual(["dangling_reference", `/models/${node}/attributes/0/type/id`]);
  });

  it("refuses a dangling root and duplicate roots", () => {
    const b = bundle();
    b.roots = ["A@default"];
    expect(refusal(loadBundle, b)?.info.reason).toBe("dangling_reference");
    b.roots = [node, node];
    expect(refusal(loadBundle, b)?.info.reason).toBe("duplicate_id");
    b.roots = ["b", "a"];
    expect(where(refusal(loadBundle, b))).toEqual(["invalid_document", "/roots"]);
  });

  it("refuses a model key that disagrees with its ID", () => {
    const b = bundle();
    b.models["Example::Other@default"] = b.models[node];
    delete b.models[node];
    b.roots = [];
    expect(refusal(loadBundle, b)?.info.reason).toBe("invalid_document");
  });

  it("refuses a format missing from capabilities", () => {
    const b = bundle();
    b.capabilities = ["json"];
    expect(refusal(loadBundle, b)?.info.reason).toBe("capability_missing");
  });

  it("checks discriminator targets and their attribute", () => {
    const b = bundle();
    const attrs = b.models[node].attributes;
    attrs[1].discriminator = { attribute: "label", cases: { a: node } };
    expect(refusal(loadBundle, b)).toBeUndefined();
    attrs[1].discriminator = { attribute: "nope", cases: { a: node } };
    expect(refusal(loadBundle, b)?.info.reason).toBe("unknown_discriminator");
    attrs[1].discriminator = { attribute: "label", cases: { a: "Gone@default" } };
    expect(refusal(loadBundle, b)?.info.reason).toBe("dangling_reference");
  });

  it("refuses an unknown value type base", () => {
    const b = bundle();
    b.value_types["V@default"] = { base: "double", facets: {} };
    expect(refusal(loadBundle, b)?.info.reason).toBe("unsupported_type");
  });
});

describe("manifest", () => {
  const manifest = (): any => copy(json("manifest.json"));
  const sha = `sha256:${"a".repeat(64)}`;

  it("refuses path traversal, absolute paths and unsorted files", () => {
    for (const path of ["../x", "/abs", "a/../b"]) {
      const m = manifest();
      m.files[0].path = path;
      expect(refusal(loadManifest, m)?.info.reason).toBe("invalid_document");
    }
    const m = manifest();
    m.files = [{ path: "b", sha256: sha }, { path: "a", sha256: sha }];
    expect(refusal(loadManifest, m)?.info.location).toBe("/files");
  });

  it("refuses a malformed digest and an unknown target", () => {
    const m = manifest();
    m.lml_checksum = "sha256:ABC";
    expect(refusal(loadManifest, m)?.info.location).toBe("/lml_checksum");
    const t = manifest();
    t.target = "go";
    expect(refusal(loadManifest, t)?.info.location).toBe("/target");
  });
});

describe("untrusted input", () => {
  const load = (src: string, format: SchemaFormat = "yaml"): unknown => loadDocument(new TextEncoder().encode(src), format);
  const reason = (src: string, format: SchemaFormat = "yaml"): ErrorCode | undefined => {
    try { load(src, format); } catch (e) { return (e as LmlError).info.reason; }
    return undefined;
  };
  const head = "lml: 2\nmodel: M\nregister: default\nattributes: []\n";

  it("rejects YAML aliases, anchors, merge keys and explicit tags", () => {
    expect(reason(`${head}mappings:\n  json: &a {rules: []}\n`)).toBe("invalid_document");
    expect(reason(`lml: 1\nmodel: M\nx: &a [1]\ny: *a\n`)).toBe("invalid_document");
    expect(reason(`${head}mappings:\n  json: !ruby/object:Object {}\n`)).toBe("invalid_document");
    expect(reason(`${head}mappings:\n  json: !!python/object/apply:os.system [id]\n`)).toBe("invalid_document");
    expect(reason(`lml: 1\nmodel: !!str M\n`)).toBe("invalid_document");
    expect(reason(`${head}mappings:\n  json:\n    <<: {rules: []}\n`)).toBe("unsupported_mapping");
  });

  it("rejects billion-laughs style alias expansion before expanding", () => {
    const bomb = ["a: &a [1,1,1,1,1,1,1,1,1]", "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]", "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]"].join("\n");
    expect(reason(`lml: 1\nmodel: M\n${bomb}\n`)).toBe("invalid_document");
  });

  it("rejects duplicate YAML keys, multi-document streams, empty input and non-string keys", () => {
    expect(reason("lml: 1\nmodel: M\nmodel: N\n")).toBe("invalid_document");
    expect(reason("lml: 1\nmodel: M\n---\nlml: 1\nmodel: N\n")).toBe("invalid_document");
    expect(reason("")).toBe("invalid_document");
    expect(reason(`${head}mappings:\n  1: {}\n`)).toBe("invalid_document");
  });

  it("rejects YAML floats in v2 and keeps them in v1", () => {
    expect(reason(`${head.replace("attributes: []", "attributes:\n  - {name: a, type: {kind: builtin, name: string}, default: {present: true, value: 1.5}}")}`)).toBe("invalid_document");
    const v1 = load("lml: 1\nmodel: M\nattributes:\n  - {name: a, default: 1.0}\n") as { canonicalJson: string };
    expect(v1.canonicalJson).toBe('{"lml":1,"model":"M","attributes":[{"name":"a","default":1.0}],"mappings":{}}');
  });

  it("does not coerce YAML 1.1 booleans or timestamps", () => {
    const loaded = load(`${head.replace("attributes: []", "attributes:\n  - {name: a, type: {kind: builtin, name: string}, default: {present: true, value: yes}}\n  - {name: b, type: {kind: builtin, name: string}, default: {present: true, value: 2020-01-01}}")}`) as any;
    expect(loaded.document.attributes[0].default.value).toBe("yes");
    expect(loaded.document.attributes[1].default.value).toBe("2020-01-01");
  });

  it("rejects bad bytes and bad JSON as invalid_document, never an uncaught error", () => {
    const raw = (b: number[], f: SchemaFormat): ErrorCode | undefined => {
      try { loadDocument(Uint8Array.from(b), f); } catch (e) { return (e as LmlError).info.reason; }
      return undefined;
    };
    expect(raw([0xff, 0xfe, 0x7b], "json")).toBe("invalid_document");
    expect(raw([0xef, 0xbb, 0xbf, 0x7b, 0x7d], "json")).toBe("invalid_document");
    expect(reason("{", "json")).toBe("invalid_document");
    expect(reason('{"lml":1,"model":"\\ud800"}', "json")).toBe("invalid_document");
    expect(reason("[".repeat(100000), "json")).toBe("invalid_document");
    expect(reason("{}", "json")).toBe("invalid_document");
    expect(reason("lml: 1", "toml" as SchemaFormat)).toBe("unsupported_format");
  });

  it("does not execute anything from a document", () => {
    const evil = { ...json("v2_node.json"), attributes: [{ name: "x", type: { kind: "builtin", name: "string" }, default: { lambda: "process.exit(1)" } }] };
    expect(refusal(loadDocument, evil)?.info.reason).toBe("lambda_default");
  });

  it("parses JSON strictly and keeps the last duplicate key", () => {
    for (const bad of ['{"lml":1,"model":"M",}', '{"lml":01,"model":"M"}', "{'lml':1}", '{"lml":1,"model":"M"} x', '{"lml":1,"model":"a\nb"}', '{"lml":1,"model":"M","x":NaN}']) {
      expect(reason(bad, "json"), bad).toBe("invalid_document");
    }
    const loaded = load('{"lml":1,"model":"A","model":"B"}', "json") as { document: { model: string } };
    expect(loaded.document.model).toBe("B");
  });
});

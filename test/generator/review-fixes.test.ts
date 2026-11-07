import { describe, expect, it } from "vitest";
import { generateModels, generateModelsWith } from "../../src/generator/index.js";
import { createKeyValueEmitter } from "../../src/codecs/index.js";
import type { Bundle } from "../../src/contracts.js";
import { attr, bundleOf, codeOf, detailOf, generated } from "./support.js";

const valueAttr = (id: string): Record<string, unknown> => ({ name: "x", type: { kind: "value", id }, required: false });

describe("M1: constructors read own properties only", () => {
  it("refuses attribute names equal to any Object.prototype member, by code", () => {
    for (const name of ["toString", "valueOf", "hasOwnProperty", "constructor", "__proto__", "isPrototypeOf"]) {
      expect(codeOf(() => generateModels(bundleOf([attr(name, "string")]), { types: {} })), name).toBe("reserved_member");
    }
  });

  it("does not take a value from the prototype chain, nor from a polluted Object.prototype", async () => {
    const { models } = await generated(bundleOf([attr("title", "string", { required: false })]));
    const inherited = new models["A"](Object.create({ title: 42 }));
    expect(inherited.title).toBe(models["ABSENT"]);
    Object.defineProperty(Object.prototype, "title", { value: 12345, configurable: true, enumerable: false, writable: true });
    try {
      expect(new models["A"]({}).title).toBe(models["ABSENT"]);
      expect(new models["A"]({ title: "own" }).title).toBe("own");
    } finally {
      delete (Object.prototype as Record<string, unknown>)["title"];
    }
  });

  it("a required member supplied only through the prototype is a violation", async () => {
    const { models } = await generated(bundleOf([attr("title", "string", { required: true })]));
    expect(() => new models["A"](Object.create({ title: "inherited" }))).toThrow(/title/);
    expect(new models["A"]({ title: "own" }).title).toBe("own");
  });
});

describe("M2/L8: fixed-table lookups use own properties", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("a %s facet is refused by a named code", (facet) => {
    const facets = JSON.parse(`{${JSON.stringify(facet)}: 5}`) as Record<string, unknown>;
    for (const base of ["string", "integer"]) {
      const code = codeOf(() => generateModels(bundleOf([valueAttr("T")], { T: { base, facets } }), { types: {} }));
      expect(code, `${base} ${facet}`).toBe("missing_type_binding");
    }
  });

  it.each(["toString", "constructor", "__proto__"])("a value type named %s that is not declared is a dangling reference", (id) => {
    expect(codeOf(() => generateModels(bundleOf([valueAttr(id)]), { types: {} }))).toBe("dangling_reference");
  });

  it("an inherited bindings.types entry is not a binding", () => {
    const bindings = Object.create({ "builtin:decimal": { module: "./x.js", export: "Decimal" } }) as { types: Record<string, never> };
    const withProto = { types: bindings } as never;
    expect(codeOf(() => generateModels(bundleOf([attr("d", "decimal")]), withProto))).toBe("missing_type_binding");
  });
});

describe("L1/L2: regex facets", () => {
  const patternBundle = (pattern: string): Bundle => bundleOf([valueAttr("T")], { T: { base: "string", facets: { pattern } } });

  it.each(["(a+)+b", "(a*)*", "(a+){2,}", "(.*x)*y", "((a+)b)+", "(?:[a-z]+\\d*)+$"])("refuses nested quantifiers: %s", (pattern) => {
    const started = Date.now();
    expect(codeOf(() => generateModels(patternBundle(pattern), { types: {} }))).toBe("invalid_document");
    expect(detailOf(() => generateModels(patternBundle(pattern), { types: {} }))).toMatch(/nested quantifiers/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("the 41 second shape never reaches generated code", () => {
    expect(() => generateModels(patternBundle("(a+)+b"), { types: {} })).toThrow();
  });

  it.each(["[A-Z]{3}-[0-9]{4}", "(foo|bar)+", "(a+)?b", "\\d+(\\.\\d+)?", "[|]+", "\\p{L}{2,}", "(ab){3}", "[(a+)+]"])("keeps safe pattern %s", (pattern) => {
    expect(codeOf(() => generateModels(patternBundle(pattern), { types: {} }))).toBeUndefined();
  });

  it("refuses a pattern that only compiles inside the wrapper", () => {
    expect(codeOf(() => generateModels(patternBundle("a)|(?:b"), { types: {} }))).toBe("invalid_document");
  });

  it("accepts a top-level alternation and anchors every branch", async () => {
    expect(codeOf(() => generateModels(patternBundle("a|b"), { types: {} }))).toBeUndefined();
    const { models } = await generated(patternBundle("ab|cd"));
    expect(new models["A"]({ x: "ab" }).x).toBe("ab");
    expect(new models["A"]({ x: "cd" }).x).toBe("cd");
    expect(() => new models["A"]({ x: "abX" })).toThrow();
    expect(() => new models["A"]({ x: "Xcd" })).toThrow();
  });

  it("an accepted pattern still anchors the whole value", async () => {
    const { models } = await generated(patternBundle("[a-c]{2}"));
    expect(new models["A"]({ x: "ab" }).x).toBe("ab");
    expect(() => new models["A"]({ x: "abc" })).toThrow();
  });
});

describe("L3: byte order, not UTF-16 order, in generator sorting", () => {
  // U+FFFD (EF BF BD) sorts before U+10000 (F0 90 80 80) by bytes; UTF-16 order puts U+10000 first.
  const low = "\u{10000}";
  const high = "\uFFFD";
  const rules = (to: string): unknown => ({ json: { rules: [{ key: [to], to }] } });
  const bundle = (cases: Record<string, string>): Bundle =>
    ({
      lml_bundle: 1, roots: ["A@default"], capabilities: ["json"], value_types: {},
      models: {
        "A@default": { lml: 2, model: "A", register: "default", attributes: [{ name: "n", type: { kind: "model", id: "B@default" }, discriminator: { attribute: "k", cases } }], mappings: rules("n") },
        "B@default": { lml: 2, model: "B", register: "default", attributes: [attr("k", "string")], mappings: rules("k") },
        "C@default": { lml: 2, model: "C", register: "default", attributes: [attr("k", "string")], mappings: rules("k") },
      },
    }) as unknown as Bundle;

  it("orders discriminator cases by UTF-8 bytes, whatever the input order", () => {
    const one = generateModelsWith(bundle({ [low]: "B@default", [high]: "C@default" }), { types: {} }, [createKeyValueEmitter("json")]);
    const two = generateModelsWith(bundle({ [high]: "C@default", [low]: "B@default" }), { types: {} }, [createKeyValueEmitter("json")]);
    const codecs = one.get("json/codecs.ts") ?? "";
    expect(codecs.indexOf(JSON.stringify(high))).toBeGreaterThan(-1);
    expect(codecs.indexOf(JSON.stringify(high))).toBeLessThan(codecs.indexOf(JSON.stringify(low)));
    expect(two.get("json/codecs.ts")).toBe(codecs);
  });
});

describe("L4: a model without `mappings`", () => {
  it("is generated with no codecs instead of crashing", () => {
    const bundle = bundleOf([attr("x", "string")]);
    delete (bundle.models["A@default"] as unknown as Record<string, unknown>)["mappings"];
    const files = generateModelsWith(bundle, { types: {} }, [createKeyValueEmitter("json")]);
    expect(files.get("json/codecs.ts")).toContain("export const CODECS = {} as const;");
    expect(files.get("models.ts")).toContain("export class A ");
  });
});

describe("L8: hash default with a __proto__ key", () => {
  it("emits the key as an own key, never as the prototype", async () => {
    const bundle = bundleOf([attr("h", "hash", { default: { present: true, value: JSON.parse('{"__proto__":{"polluted":1},"k":2}') } })]);
    const { models } = await generated(bundle);
    const a = new models["A"]();
    expect(Object.keys(a.h).sort()).toEqual(["__proto__", "k"]);
    expect(Object.getPrototypeOf(a.h)).toBe(Object.prototype);
    expect(a.h.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("L9: collections and hashes are copied, frozen and plain", () => {
  const bundle = (): Bundle => bundleOf([attr("xs", "string", { collection: { min: 1, max: 1 } }), attr("h", "hash")]);

  it("a later mutation of the caller's array does not change the instance", async () => {
    const { models } = await generated(bundle());
    const source = ["a"];
    const a = new models["A"]({ xs: source });
    source.push("b", "c");
    expect(a.xs).toEqual(["a"]);
    expect(Object.isFrozen(a.xs)).toBe(true);
  });

  it("copies and freezes a hash, nested values included", async () => {
    const { models } = await generated(bundle());
    const hash = { k: { deep: [1, 2] } };
    const a = new models["A"]({ xs: ["a"], h: hash });
    hash.k.deep.push(3);
    expect(a.h).toEqual({ k: { deep: [1, 2] } });
    expect(Object.isFrozen(a.h)).toBe(true);
    expect(Object.isFrozen(a.h.k.deep)).toBe(true);
  });

  it("refuses a Map (and other non-plain objects) as a hash", async () => {
    const { models } = await generated(bundle());
    expect(() => new models["A"]({ xs: ["a"], h: new Map([["k", 1]]) })).toThrow(/h/);
    expect(() => new models["A"]({ xs: ["a"], h: new Date() })).toThrow(/h/);
    expect(new models["A"]({ xs: ["a"], h: { k: 1 } }).h).toEqual({ k: 1 });
  });
});

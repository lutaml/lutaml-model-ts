import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import type { Bindings, Bundle, Emitter, ErrorCode, ModelDocument, SourceMap } from "../../src/contracts.js";
import { generateModels, generateModelsWith } from "../../src/generator/index.js";

const REPO = resolve(import.meta.dirname, "../..");
const FIXTURES = join(REPO, "test/fixtures/ts_generated");
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function load(name: string): Bundle {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Bundle;
}

const STUB_BINDINGS: Bindings = {
  types: {
    "builtin:decimal": { module: "./values-stub.js", export: "Decimal" },
    "builtin:rational": { module: "./values-stub.js", export: "Rational" },
    xml_id: { module: "./values-stub.js", export: "XmlId" },
  },
};
const NO_BINDINGS: Bindings = { types: {} };

function write(dir: string, files: SourceMap): void {
  for (const [path, text] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/** Generates into a fresh dir with a stub values module and package.json. */
function generateInto(
  bundle: Bundle,
  bindings: Bindings,
  contractsModule?: string,
  emitters: readonly Emitter[] = [],
): { dir: string; files: SourceMap } {
  const dir = mkdtempSync(join(tmpdir(), "lml-gen-"));
  created.push(dir);
  const files = generateModelsWith(bundle, bindings, emitters, contractsModule === undefined ? {} : { contractsModule });
  write(dir, files);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  copyFileSync(join(FIXTURES, "values-stub.ts"), join(dir, "values-stub.ts"));
  return { dir, files };
}

/** Strict compile of generated output; the package import maps to src. */
function tscCheck(dir: string): void {
  const config = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      // src/index.ts re-exports the node-backed loaders, so the paths mapping pulls node types in.
      typeRoots: [join(REPO, "node_modules/@types")],
      types: ["node"],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      skipLibCheck: false,
      noEmit: true,
      paths: { "lutaml-model-ts": [join(REPO, "src/index.ts")] },
    },
    include: ["./**/*.ts"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config));
  const tsc = join(REPO, "node_modules/typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const out = error as { stdout?: string; stderr?: string };
    throw new Error(`tsc failed:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
  }
}

function codeOf(run: () => unknown): ErrorCode | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LmlError) return error.info.reason;
    throw error;
  }
  return undefined;
}

function mutate(bundle: Bundle, edit: (draft: { models: Record<string, ModelDocument>; value_types: Record<string, unknown> }) => void): Bundle {
  const draft = structuredClone(bundle) as unknown as { models: Record<string, ModelDocument>; value_types: Record<string, unknown> };
  edit(draft);
  return draft as unknown as Bundle;
}

describe("generateModels: output shape", () => {
  it("emits runtime, models and index, deterministically and sorted", () => {
    const a = generateModels(load("rich.json"), STUB_BINDINGS);
    const b = generateModels(structuredClone(load("rich.json")), STUB_BINDINGS);
    expect([...a.keys()]).toEqual(["index.ts", "models.ts", "runtime.ts"]);
    expect([...b]).toEqual([...a]);
  });

  it("uses no any, no eval and no dynamic imports", () => {
    const all = [...generateModels(load("rich.json"), STUB_BINDINGS).values()].join("\n");
    expect(all).not.toMatch(/\bany\b/);
    expect(all).not.toMatch(/\beval\(|new Function|import\(/);
  });
});

describe("generated code compiles under the strict tsconfig", () => {
  it("compiles the contract self-referential node bundle", { timeout: 120_000 }, () => {
    const { dir } = generateInto(load("contract_bundle.json"), NO_BINDINGS);
    tscCheck(dir);
  });

  it("control: the compile harness really fails on a type error", { timeout: 120_000 }, () => {
    const { dir } = generateInto(load("contract_bundle.json"), NO_BINDINGS);
    writeFileSync(join(dir, "broken.ts"), "export const n: number = 'x';\n");
    expect(() => tscCheck(dir)).toThrow(/TS2322/);
  });

  it("compiles the rich bundle (cycles, enums, bounds, defaults, bindings)", { timeout: 120_000 }, () => {
    const { dir, files } = generateInto(load("rich.json"), STUB_BINDINGS);
    tscCheck(dir);
    const models = files.get("models.ts") ?? "";
    expect(models).toContain("export class ShopItem {");
    expect(models).toContain("export class ShopItem_alt {");
    expect(models).toContain('readonly "x-y"');
  });
});

describe("generated code executes", () => {
  const contracts = "./contracts-shim.js";
  async function loadRich(): Promise<Record<string, any>> {
    const { dir } = generateInto(load("rich.json"), STUB_BINDINGS, contracts);
    copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
    return (await import(pathToFileURL(join(dir, "index.ts")).href)) as Record<string, any>;
  }

  it("keeps absent, null and default as distinct states", async () => {
    const m = await loadRich();
    const { ShopItem, ABSENT } = m;
    const item = new ShopItem({ sku: "ABC-1234" });
    expect(item.label).toBe(ABSENT);
    expect(new ShopItem({ sku: "ABC-1234", label: null }).label).toBeNull();
    expect(new ShopItem({ sku: "ABC-1234", label: ABSENT }).label).toBe(ABSENT);
    expect(new ShopItem({ sku: "ABC-1234", label: "x" }).label).toBe("x");
    expect(item.qty).toBe(1n);
    expect(new ShopItem({ sku: "ABC-1234", qty: null }).qty).toBeNull();
    expect(item.status).toBe("draft");
    expect(item.flag).toBe(false);
    expect(item.tags).toEqual([]);
    expect(item.price).toEqual({ lexical: "9.50" });
    expect(item.blob).toEqual(new Uint8Array([1, 2, 3]));
    expect(Object.isFrozen(item)).toBe(true);
  });

  it("enforces requiredness, bounds, enums and facets with located violations", async () => {
    const m = await loadRich();
    const { ShopItem, ShopBundle, ValidationError } = m;
    const violations = (input: unknown): string[] =>
      (ShopItem.validate(input) as { path: string; code: string }[]).map((v) => `${v.path} ${v.code}`);
    expect(violations({})).toEqual(["/sku required"]);
    expect(violations({ sku: null })).toEqual(["/sku null_not_allowed"]);
    expect(violations({ sku: "abc-1" })).toEqual(["/sku facet"]);
    expect(violations({ sku: "ABC-1234", qty: 101n })).toEqual(["/qty facet"]);
    expect(violations({ sku: "ABC-1234", qty: 100 })).toEqual(["/qty type"]);
    expect(violations({ sku: "ABC-1234", status: "gone" })).toEqual(["/status enum"]);
    expect(violations({ sku: "ABC-1234", level: 4n })).toEqual(["/level enum"]);
    expect(violations({ sku: "ABC-1234", level: 2n })).toEqual([]);
    expect(violations({ sku: "ABC-1234", tags: ["a", "b", "c", "d"] })).toEqual(["/tags max_items"]);
    expect(violations({ sku: "ABC-1234", tags: ["ok", " bad"] })).toEqual(["/tags/1 type"]);
    expect(violations({ sku: "ABC-1234", ref: "9bad" })).toEqual(["/ref type"]);
    expect(violations({ sku: "ABC-1234", released: "2024-02-30" })).toEqual(["/released type"]);
    expect(violations({ sku: "ABC-1234", released: "2024-02-29Z" })).toEqual([]);
    expect(violations({ sku: "ABC-1234", span: "P1DT2H" })).toEqual([]);
    expect(violations({ sku: "ABC-1234", span: "P" })).toEqual(["/span type"]);
    expect(violations({ sku: "ABC-1234", qn: { namespace: null, local: "a" } })).toEqual([]);
    expect(violations({ sku: "ABC-1234", meta: { a: [1, { b: null }] } })).toEqual([]);
    expect(violations({ sku: "ABC-1234", meta: { a: Number.NaN } })).toEqual(["/meta type"]);
    expect(violations({ sku: "ABC-1234", surprise: 1 })).toEqual(["/surprise unknown_member"]);
    expect(violations("nope")).toEqual([" type"]);
    expect(() => new ShopItem({ sku: "bad" })).toThrow(ValidationError);
    expect(ShopBundle.validate({ items: [] }).map((v: { code: string }) => v.code)).toEqual(["min_items"]);
    expect(ShopBundle.validate({}).map((v: { code: string }) => v.code)).toEqual(["required"]);
  });

  it("types cycles and discriminated unions by instance", async () => {
    const m = await loadRich();
    const { ShopItem, ShopBundle, ShopHolder, ShopCircle, ShopSquare } = m;
    const item = new ShopItem({ sku: "ABC-1234" });
    const bundle = new ShopBundle({ items: [item], owner: item });
    expect(new ShopItem({ sku: "ABC-1234", bundle }).bundle).toBe(bundle);
    expect(ShopBundle.validate({ items: [{}] }).map((v: { path: string }) => v.path)).toEqual(["/items/0"]);
    expect(new ShopHolder({ thing: new ShopCircle({ radius: 2n }) }).thing).toBeInstanceOf(ShopCircle);
    expect(new ShopHolder({ thing: new ShopSquare({ side: 2n }) }).thing).toBeInstanceOf(ShopSquare);
    expect(() => new ShopHolder({ thing: new ShopItem({ sku: "ABC-1234" }) })).toThrow();
  });

  it("validates ordered-content tokens against member collections", async () => {
    const m = await loadRich();
    const { ShopItem, ShopBundle } = m;
    const item = new ShopItem({ sku: "ABC-1234" });
    const ok = new ShopBundle({
      items: [item],
      note: "hi",
      __lml_content: [
        { kind: "element", attribute: "items", index: 0 },
        { kind: "text", attribute: "note", index: 0 },
        { kind: "cdata", literal: "<raw>" },
      ],
    });
    expect(ok.__lml_content).toHaveLength(3);
    const bad = (token: unknown): string[] =>
      ShopBundle.validate({ items: [item], __lml_content: [token] }).map((v: { code: string }) => v.code);
    expect(bad({ kind: "element", attribute: "items", index: 1 })).toEqual(["ordered_content"]);
    expect(bad({ kind: "text", attribute: "note", index: 0 })).toEqual(["ordered_content"]);
    expect(bad({ kind: "element", attribute: "nope", index: 0 })).toEqual(["ordered_content"]);
    expect(new ShopBundle({ items: [item] }).__lml_content).toBe(m["ABSENT"]);
  });

  it("surfaces a default that violates its own facets at construction", async () => {
    const bundle = mutate(load("rich.json"), (d) => {
      const attr = d.models["Shop::Item@default"]?.attributes.find((a) => a.name === "qty");
      (attr as { default: unknown }).default = { present: true, value: 500 };
    });
    const { dir } = generateInto(bundle, STUB_BINDINGS, "./contracts-shim.js");
    copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
    const m = (await import(pathToFileURL(join(dir, "index.ts")).href)) as Record<string, any>;
    expect(() => new m["ShopItem"]({ sku: "ABC-1234" })).toThrow(m["ValidationError"]);
  });
});

describe("generateModels: rejections", () => {
  const rich = load("rich.json");

  it("rejects target name collisions", () => {
    const bundle = mutate(rich, (d) => {
      const clone = structuredClone(d.models["Shop::Circle@default"]) as ModelDocument;
      d.models["ShopCircle@default"] = { ...clone, model: "ShopCircle" } as ModelDocument;
    });
    expect(codeOf(() => generateModels(bundle, STUB_BINDINGS))).toBe("duplicate_id");
  });

  it("rejects an init-type name colliding with a class", () => {
    const bundle = mutate(rich, (d) => {
      const clone = structuredClone(d.models["Shop::Circle@default"]) as ModelDocument;
      d.models["Shop::CircleInit@default"] = { ...clone, model: "Shop::CircleInit" } as ModelDocument;
    });
    expect(codeOf(() => generateModels(bundle, STUB_BINDINGS))).toBe("duplicate_id");
  });

  it("rejects reserved names and non-portable model names", () => {
    const reserved = mutate(rich, (d) => {
      d.models["Maybe@default"] = { ...(structuredClone(d.models["Shop::Circle@default"]) as ModelDocument), model: "Maybe" };
    });
    expect(codeOf(() => generateModels(reserved, STUB_BINDINGS))).toBe("invalid_document");
    const odd = mutate(rich, (d) => {
      d.models["shop::lower@default"] = { ...(structuredClone(d.models["Shop::Circle@default"]) as ModelDocument), model: "shop::lower" };
    });
    expect(codeOf(() => generateModels(odd, STUB_BINDINGS))).toBe("invalid_document");
  });

  it("rejects exact types without a binding", () => {
    expect(codeOf(() => generateModels(rich, NO_BINDINGS))).toBe("missing_type_binding");
  });

  it("rejects unknown facets, float/double and unknown builtins", () => {
    const facet = mutate(rich, (d) => {
      d.value_types["sku"] = { base: "string", facets: { total_digits: 3 } };
    });
    expect(codeOf(() => generateModels(facet, STUB_BINDINGS))).toBe("missing_type_binding");
    const withType = (name: string): Bundle =>
      mutate(rich, (d) => {
        const attr = d.models["Shop::Circle@default"]?.attributes[0] as { type: unknown };
        attr.type = { kind: "builtin", name };
      });
    expect(codeOf(() => generateModels(withType("float"), STUB_BINDINGS))).toBe("unsupported_type");
    expect(codeOf(() => generateModels(withType("complex"), STUB_BINDINGS))).toBe("unknown_type");
  });

  it("rejects dangling references and unknown discriminator targets", () => {
    const dangling = mutate(rich, (d) => {
      const attr = d.models["Shop::Bundle@default"]?.attributes[1] as { type: unknown };
      attr.type = { kind: "model", id: "Nope@default" };
    });
    expect(codeOf(() => generateModels(dangling, STUB_BINDINGS))).toBe("dangling_reference");
    const disc = mutate(rich, (d) => {
      const attr = d.models["Shop::Holder@default"]?.attributes[0] as { discriminator: { cases: Record<string, string> } };
      attr.discriminator.cases["z"] = "Nope@default";
    });
    expect(codeOf(() => generateModels(disc, STUB_BINDINGS))).toBe("unknown_discriminator");
    const root = { ...rich, roots: ["Nope@default"] };
    expect(codeOf(() => generateModels(root, STUB_BINDINGS))).toBe("dangling_reference");
  });

  it("rejects reserved members, bad bounds, collection classes and bad defaults", () => {
    const attrOf = (d: { models: Record<string, ModelDocument> }): Record<string, unknown> =>
      d.models["Shop::Circle@default"]?.attributes[0] as unknown as Record<string, unknown>;
    expect(codeOf(() => generateModels(mutate(rich, (d) => { attrOf(d)["name"] = "__lml_content"; }), STUB_BINDINGS))).toBe("reserved_member");
    expect(codeOf(() => generateModels(mutate(rich, (d) => { attrOf(d)["name"] = "constructor"; }), STUB_BINDINGS))).toBe("reserved_member");
    expect(codeOf(() => generateModels(mutate(rich, (d) => { attrOf(d)["collection"] = { min: 3, max: 1 }; }), STUB_BINDINGS))).toBe("invalid_document");
    expect(codeOf(() => generateModels(mutate(rich, (d) => { attrOf(d)["collection"] = { min: 0, max: null, class: "Bag" }; }), STUB_BINDINGS))).toBe("unsupported_type");
    expect(codeOf(() => generateModels(mutate(rich, (d) => { attrOf(d)["default"] = { present: true, value: "x" }; }), STUB_BINDINGS))).toBe("non_serializable_default");
    expect(codeOf(() => generateModels(mutate(rich, (d) => { attrOf(d)["default"] = { present: true, value: null }; }), STUB_BINDINGS))).toBe("non_serializable_default");
    expect(codeOf(() => generateModels(mutate(rich, (d) => { attrOf(d)["values"] = ["a"]; }), STUB_BINDINGS))).toBe("invalid_document");
  });
});

describe("generateModelsWith: extension emitters", () => {
  const rich = load("rich.json");
  const emitter = (name: string, files: Record<string, string>): Emitter => ({
    name,
    emit: () => new Map(Object.entries(files)),
  });

  it("merges emitter files and re-exports each under its namespace", () => {
    const files = generateModelsWith(rich, STUB_BINDINGS, [
      emitter("xml", { "xml/index.ts": "export const x = 1;\n" }),
      emitter("json", { "json/index.ts": "export const j = 1;\n", "json/more.ts": "export {};\n" }),
    ]);
    expect([...files.keys()]).toEqual(["index.ts", "json/index.ts", "json/more.ts", "models.ts", "runtime.ts", "xml/index.ts"]);
    const index = files.get("index.ts") ?? "";
    expect(index).toContain('export * as json from "./json/index.js";');
    expect(index).toContain('export * as xml from "./xml/index.js";');
  });

  it("rejects emitters that escape their directory, collide or lack an entry", () => {
    const run = (...emitters: Emitter[]): ErrorCode | undefined =>
      codeOf(() => generateModelsWith(rich, STUB_BINDINGS, emitters));
    expect(run(emitter("xml", { "xml/index.ts": "", "models.ts": "" }))).toBe("invalid_document");
    expect(run(emitter("xml", { "xml/../models.ts": "", "xml/index.ts": "" }))).toBe("invalid_document");
    expect(run(emitter("xml", { "xml/other.ts": "" }))).toBe("invalid_document");
    expect(run(emitter("models", { "models/index.ts": "" }))).toBe("invalid_document");
    expect(run(emitter("Xml", { "Xml/index.ts": "" }))).toBe("invalid_document");
    expect(
      run(emitter("xml", { "xml/index.ts": "" }), emitter("xml", { "xml/index.ts": "" })),
    ).toBe("duplicate_id");
  });

  it("compiles with an extension emitter in the output", { timeout: 120_000 }, () => {
    const { dir } = generateInto(rich, STUB_BINDINGS, undefined, [
      emitter("json", { "json/index.ts": "export const encoded = 1;\n" }),
    ]);
    tscCheck(dir);
  });
});

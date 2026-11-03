import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import type { Bindings, Bundle, ErrorCode, KeyValueRule } from "../../src/contracts.js";
import { createKeyValueEmitter, generateJsonCodecs, jsonEmitter } from "../../src/codecs/index.js";
import { generateModelsWith } from "../../src/generator/index.js";

const REPO = resolve(import.meta.dirname, "../..");
const FIXTURES = join(import.meta.dirname, "fixtures");
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

interface OracleCase {
  id: string;
  model_id: string;
  input: string;
  expected_output?: string;
  expected_error?: string;
  divergence?: string;
  ruby_classes?: string[];
}
interface Oracle {
  bundle: Bundle;
  cases: OracleCase[];
}

const rawOracle = JSON.parse(readFileSync(join(FIXTURES, "oracle.json"), "utf8")) as Oracle;

/**
 * Ruby exports key-value polymorphism on the rule; the generated model types
 * need the same discriminator on the attribute (06c). Copy it across.
 */
function withAttributeDiscriminators(bundle: Bundle): Bundle {
  const draft = structuredClone(bundle) as never as {
    models: Record<string, { attributes: { name: string; discriminator?: unknown }[]; mappings: { json?: { rules: { to: string; discriminator?: unknown }[] } } }>;
  };
  for (const doc of Object.values(draft.models)) {
    for (const rule of doc.mappings.json?.rules ?? []) {
      if (rule.discriminator === undefined) continue;
      const attr = doc.attributes.find((a) => a.name === rule.to);
      if (attr !== undefined) attr.discriminator = rule.discriminator;
    }
  }
  return draft as never;
}
const oracle: Oracle = { ...rawOracle, bundle: withAttributeDiscriminators(rawOracle.bundle) };
const codecBundle = JSON.parse(readFileSync(join(FIXTURES, "codec_bundle.json"), "utf8")) as Bundle;

const EXACT_BINDINGS: Bindings = {
  types: {
    "builtin:decimal": { module: "./exact-stub.js", export: "Decimal" },
    "builtin:rational": { module: "./exact-stub.js", export: "Rational" },
  },
};
const NONE: Bindings = { types: {} };

type Format = "json" | "yaml";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = Record<string, any>;

function generateInto(bundle: Bundle, bindings: Bindings, format: Format = "json"): { dir: string; files: ReadonlyMap<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "lml-codec-"));
  created.push(dir);
  const contractsModule = "./contracts-shim.js";
  const files = generateModelsWith(bundle, bindings, [createKeyValueEmitter(format, { contractsModule })], { contractsModule });
  for (const [path, text] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
  writeFileSync(join(dir, "exact-stub.ts"), `export * from ${JSON.stringify(join(REPO, "src/codecs/exact.js"))};\n`);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  return { dir, files };
}

function tscCheck(dir: string): void {
  const config = {
    compilerOptions: {
      target: "ES2022", lib: ["ES2022"], module: "NodeNext", moduleResolution: "NodeNext", types: [],
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
      noFallthroughCasesInSwitch: true, noUnusedLocals: true, noUnusedParameters: true,
      verbatimModuleSyntax: true, isolatedModules: true, skipLibCheck: false, noEmit: true,
    },
    include: ["./**/*.ts"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config));
  try {
    execFileSync(process.execPath, [join(REPO, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const out = error as { stdout?: string; stderr?: string };
    throw new Error(`tsc failed:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
  }
}

async function load(dir: string): Promise<Loaded> {
  return (await import(pathToFileURL(join(dir, "index.ts")).href)) as Loaded;
}

function infoOf(run: () => unknown): LmlError["info"] | undefined {
  try {
    run();
  } catch (error) {
    // Generated code carries its own copy of the contracts module.
    const info = (error as { name?: string; info?: LmlError["info"] }).info;
    if ((error as Error).name === "LmlError" && info !== undefined) return info;
    throw error;
  }
  return undefined;
}

function codeOf(run: () => unknown): ErrorCode | undefined {
  return infoOf(run)?.reason;
}

function mutated(edit: (draft: Bundle & { models: Record<string, { mappings: { json?: any }; attributes: any[] }> }) => void): Bundle {
  const draft = structuredClone(codecBundle) as never;
  edit(draft);
  return draft;
}

describe("emitter output", () => {
  it("writes only json/{codecs,index,runtime}.ts, deterministically, with no any/eval", () => {
    const a = generateJsonCodecs(codecBundle, EXACT_BINDINGS);
    const b = generateJsonCodecs(structuredClone(codecBundle), EXACT_BINDINGS);
    expect([...a.keys()]).toEqual(["json/codecs.ts", "json/index.ts", "json/runtime.ts"]);
    expect([...b]).toEqual([...a]);
    const all = [...a.values()].join("\n");
    expect(all).not.toMatch(/: any\b|<any>|\bas any\b/);
    expect(all).not.toMatch(/\beval\(|new Function|import\(/);
    expect(jsonEmitter.name).toBe("json");
  });

  it("skips models with no json mapping and emits codecs only for mapped ones", () => {
    const codecs = generateJsonCodecs(codecBundle, EXACT_BINDINGS).get("json/codecs.ts") ?? "";
    expect(codecs).toContain("export function decodeCodecOrder");
    expect(codecs).toContain("export function decodeCodecLine");
    expect(codecs).not.toContain("CodecPlain");
  });
});

describe("emitted codecs compile under strict tsc", () => {
  it("compiles json codecs for the hand-written bundle", { timeout: 180_000 }, () => {
    tscCheck(generateInto(codecBundle, EXACT_BINDINGS).dir);
  });

  it("compiles json codecs for the Ruby-exported oracle bundle (incl. polymorphism)", { timeout: 180_000 }, () => {
    tscCheck(generateInto(oracle.bundle, NONE).dir);
  });

  it("compiles yaml codecs", { timeout: 180_000 }, () => {
    const bundle = structuredClone(codecBundle) as never as { models: Record<string, { mappings: { json?: unknown; yaml?: unknown } }> };
    for (const doc of Object.values(bundle.models)) doc.mappings.yaml = doc.mappings.json;
    tscCheck(generateInto(bundle as never, EXACT_BINDINGS, "yaml").dir);
  });

  it("control: the harness fails on a type error in emitted output", { timeout: 180_000 }, () => {
    const { dir } = generateInto(codecBundle, EXACT_BINDINGS);
    writeFileSync(join(dir, "broken.ts"), "export const n: number = 'x';\n");
    expect(() => tscCheck(dir)).toThrow(/TS2322/);
  });
});

describe("Ruby oracle replay", () => {
  let codecs: Record<string, any> | undefined;
  async function get(): Promise<Record<string, any>> {
    if (codecs === undefined) {
      const mod = await load(generateInto(oracle.bundle, NONE).dir);
      codecs = mod["json"].CODECS as Record<string, any>;
    }
    return codecs;
  }

  const strict = oracle.cases.filter((c) => c.divergence === "ruby-lenient-ts-strict");
  const exact = oracle.cases.filter((c) => c.expected_output !== undefined && c.divergence !== "ruby-lenient-ts-strict");
  const failing = oracle.cases.filter((c) => c.expected_error !== undefined);

  it("has the expected case population", () => {
    expect([exact.length, strict.length, failing.length, oracle.cases.length]).toEqual([25, 2, 3, 30]);
  });

  for (const c of exact) {
    it(`${c.id}: same output as Ruby`, async () => {
      const codec = (await get())[c.model_id];
      const value = codec.parse(c.input);
      expect(codec.stringify(value)).toBe(c.expected_output);
      if (c.ruby_classes !== undefined) {
        const m = c.model_id.endsWith("Kennel@default") ? [...(value.animals === undefined || typeof value.animals === "symbol" ? [] : value.animals), ...(value.pet === undefined || typeof value.pet === "symbol" || value.pet === null ? [] : [value.pet])] : [];
        expect(m.map((x: object) => x.constructor.name.replace("OracleModels", ""))).toEqual(c.ruby_classes);
      }
    });
  }

  for (const c of failing) {
    it(`${c.id}: Ruby ${c.expected_error} -> TS LmlError`, async () => {
      const codec = (await get())[c.model_id];
      const info = infoOf(() => codec.parse(c.input));
      expect(info).toBeDefined();
      expect(info?.reason).toBe(c.id.includes("poly-unknown") ? "unknown_discriminator" : "invalid_document");
      expect(info?.format).toBe("json");
      expect(info?.model_id).toBe(c.model_id);
    });
  }

  for (const c of strict) {
    it(`${c.id}: stated divergence, TS is strict where Ruby coerces`, async () => {
      const codec = (await get())[c.model_id];
      expect(codeOf(() => codec.parse(c.input))).toBe("invalid_document");
    });
  }

  it("locates a nested wire error by JSON pointer", async () => {
    const codec = (await get())["OracleModels::Rec@default"];
    const info = infoOf(() => codec.parse('{"kids":[{"name":"ok"},{"name":5}]}'));
    expect(info?.location).toBe("/kids/1/name");
    expect(info?.reason).toBe("invalid_document");
  });
});

describe("portable exact wire profile", () => {
  let order: Record<string, any>;
  let mod: Loaded;
  async function get(): Promise<Loaded> {
    if (mod === undefined) {
      mod = await load(generateInto(codecBundle, EXACT_BINDINGS).dir);
      order = mod["json"].CODECS as Record<string, any>;
    }
    return mod;
  }
  const codec = async (): Promise<any> => {
    await get();
    return order["Codec::Order@default"];
  };

  it("carries integers beyond binary64 as exact strings and refuses JSON numbers", async () => {
    const c = await codec();
    const value = c.parse('{"order_id":"o","big":"9007199254740993","qty":"-7"}');
    expect(value.big).toBe(9007199254740993n);
    expect(JSON.parse(c.stringify(value))).toMatchObject({ order_id: "o", qty: "-7", big: "9007199254740993" });
    const info = infoOf(() => c.parse('{"order_id":"o","big":9007199254740993}'));
    expect(info?.reason).toBe("invalid_document");
    expect(info?.location).toBe("/big");
  });

  it("preserves decimal lexical form and ratio values exactly", async () => {
    const c = await codec();
    const value = c.parse('{"order_id":"o","price":"0.10","ratio":"0.125"}');
    expect(value.price.lexical).toBe("0.10");
    const out = JSON.parse(c.stringify(value)) as Record<string, unknown>;
    expect(out["price"]).toBe("0.10");
    expect(out["ratio"]).toBe("0.125");
    expect(codeOf(() => c.parse('{"order_id":"o","price":"1e3"}'))).toBe("invalid_document");
  });

  it("applies the nil policy to absent and null alike, and renders defaults", async () => {
    const c = await codec();
    expect(JSON.parse(c.stringify(c.parse('{"order_id":"o"}')))).toEqual({ order_id: "o", price: null, currency: "USD" });
    expect(JSON.parse(c.stringify(c.parse('{"order_id":"o","price":null,"currency":null}')))).toEqual({ order_id: "o", price: null });
  });

  it("round-trips bytes, qname, dates, hash, enum-like value types, nested lines and aliases", async () => {
    const c = await codec();
    const text =
      '{"order_id":"o","blob":"AQID","raw":"0aff","qn":{"namespace":null,"local":"a"},"at":"2024-02-29",' +
      '"extras":{"k":[1,null]},"currency":"EUR","code":"ABC12","lines":[{"sku":"s","units":"3"},{"sku":"t"}],"open":false}';
    const value = c.parse(text);
    expect(value.blob).toEqual(new Uint8Array([1, 2, 3]));
    expect(value.raw).toEqual(new Uint8Array([10, 255]));
    expect(value.lines[1].units).toBe(1n);
    expect(JSON.parse(c.stringify(value))).toEqual({
      order_id: "o", price: null, blob: "AQID", raw: "0aff", qn: { namespace: null, local: "a" }, when: "2024-02-29",
      extras: { k: [1, null] }, currency: "EUR", code: "ABC12",
      lines: [{ sku: "s", units: "3" }, { sku: "t", units: "1" }], open: false,
    });
    expect(Object.keys(JSON.parse(c.stringify(value)) as object)[0]).toBe("order_id");
  });

  it("refuses model violations as located wire errors", async () => {
    const c = await codec();
    const at = (text: string) => infoOf(() => c.parse(text));
    expect(at('{}')?.reason).toBe("invalid_document");
    expect(at('{"order_id":"o","code":"abc"}')?.location).toBe("/code");
    expect(at('{"order_id":"o","lines":[{"sku":"s"},{"units":"2"}]}')?.location).toBe("/lines/1/sku");
    expect(at('{"order_id":"o","when":"2024-02-30"}')?.location).toBe("/when");
    expect(at('{"order_id":"o","blob":"!!"}')?.location).toBe("/blob");
    expect(at('{"order_id":"o","open":"yes"}')?.location).toBe("/open");
    expect(at("{")?.location).toBe("/input");
    expect(at("{")?.reason).toBe("invalid_document");
  });

  it("refuses a non-terminating rational on encode with its own code", async () => {
    const { json } = await get();
    const exact = await import(pathToFileURL(join(REPO, "src/codecs/exact.ts")).href) as Loaded;
    const m = await get();
    const third = exact["parseRational"]("0.5");
    const bad = { numerator: 1n, denominator: 3n };
    const order = new m["CodecOrder"]({ id: "o", ratio: third });
    expect(JSON.parse(json.codecCodecOrder.stringify(order))["ratio"]).toBe("0.5");
    const broken = new m["CodecOrder"]({ id: "o", ratio: bad });
    expect(codeOf(() => json.codecCodecOrder.stringify(broken))).toBe("nonterminating_rational");
  });
});

describe("yaml codecs", () => {
  it("decode/encode a tree and parse/stringify through a caller-supplied library", async () => {
    const bundle = structuredClone(codecBundle) as never as { models: Record<string, { mappings: { json?: unknown; yaml?: unknown } }> };
    for (const doc of Object.values(bundle.models)) doc.mappings.yaml = doc.mappings.json;
    const mod = await load(generateInto(bundle as never, EXACT_BINDINGS, "yaml").dir);
    const c = mod["yaml"].CODECS["Codec::Line@default"];
    const fake = { parse: (t: string): unknown => JSON.parse(t) as unknown, stringify: (v: unknown): string => JSON.stringify(v) };
    expect(c.format).toBe("yaml");
    expect(c.stringify(c.parse('{"sku":"s","units":"2"}', fake), fake)).toBe('{"sku":"s","units":"2"}');
    expect(infoOf(() => c.parse("{", fake))?.format).toBe("yaml");
  });
});

describe("named refusals", () => {
  const withRule = (edit: (rules: KeyValueRule[], order: any) => void): Bundle =>
    mutated((d) => {
      const order = d.models["Codec::Order@default"];
      edit(order?.mappings.json.rules, order);
    });
  const refused = (bundle: Bundle, text: RegExp): void => {
    const info = infoOf(() => generateJsonCodecs(bundle, EXACT_BINDINGS));
    expect(info?.reason).toBe("unsupported_mapping");
    expect(info?.detail ?? "").toMatch(text);
    expect(info?.model_id).toBeDefined();
  };

  it("as_blank", () => refused(withRule((r) => { r[0] = { ...(r[0] as object), render: { nil: "as_blank" } } as never; }), /as_blank/));
  it("mapping-level root_mappings", () => refused(withRule((_r, o) => { o.mappings.json.root_mappings = { id: "key" }; }), /root_mappings/));
  it("mapping-level child_mappings", () => refused(withRule((_r, o) => { o.mappings.json.child_mappings = { id: "key" }; }), /child_mappings/));
  it("rule-level child_mappings", () => refused(withRule((r) => { (r[10] as any).child_mappings = { id: "key" }; }), /child_mappings/));
  it("rule-level root_mappings", () => refused(withRule((r) => { (r[10] as any).root_mappings = { id: "key" }; }), /root_mappings/));
  it("rule-level polymorphic_map", () => refused(withRule((r) => { (r[10] as any).polymorphic_map = {}; }), /polymorphic_map/));
  it("several rules on one attribute", () => refused(withRule((r) => { r.push({ key: ["extra"], to: "qty" }); }), /several rules/));
  it("duplicate wire keys", () => refused(withRule((r) => { (r[1] as any).key = ["order_id"]; }), /duplicate wire key/));
  it("render policy outside omit/as_nil/as_empty", () => refused(withRule((r) => { (r[0] as any).render = { nil: "sometimes" }; }), /policy/));
  it("a referenced model without a json mapping", () =>
    refused(mutated((d) => { delete d.models["Codec::Line@default"]?.mappings.json; }), /no json mapping/));
  it("a discriminator whose base model has no rule for the discriminator attribute", () =>
    refused(
      mutated((d) => {
        const order = d.models["Codec::Order@default"] as NonNullable<(typeof d.models)[string]>;
        const disc = { attribute: "nope", cases: { a: "Codec::Line@default" } };
        order.mappings.json.rules[12].discriminator = disc;
        order.attributes[12].discriminator = disc;
      }),
      /discriminator attribute nope/,
    ));

  it("a Ruby rule-level discriminator without the attribute-level one the model types need", () =>
    refused(rawOracle.bundle, /rule-level discriminator needs an identical attribute-level/));

  it("missing exact binding keeps the generator's own code", () => {
    expect(codeOf(() => generateJsonCodecs(codecBundle, NONE))).toBe("missing_type_binding");
  });
});

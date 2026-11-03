import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Bundle } from "../../src/contracts.js";
import { createKeyValueEmitter } from "../../src/codecs/index.js";
import { generateModelsWith } from "../../src/generator/index.js";
import { createXmlEmitter } from "../../src/xml/index.js";

const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("moxml-ts")'], { encoding: "utf8" });
const xmlAvailable = probe.status === 0;

const REPO = resolve(import.meta.dirname, "../..");
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

interface Vectors { encode: { bits: string; wire: string }[] }
const vectors = JSON.parse(readFileSync(join(REPO, "test/lml/fixtures/float_wire_vectors.json"), "utf8")) as Vectors;
const fromBits = (hex: string): number => Buffer.from(hex, "hex").readDoubleBE(0);

const float = (name: string, extra: object = {}): unknown => ({
  name, type: { kind: "builtin", name: "float" }, required: false, collection: false,
  default: { present: false }, initialize_empty: false, ...extra,
});
const keyValue = (name: string): unknown => ({ key: [name], to: name, render: { nil: "omit", empty: "omit", default: false } });

function bundle(attributes: unknown[], name = "Doc"): Bundle {
  const names = attributes.map((a) => (a as { name: string }).name);
  const mapping = { rules: names.map(keyValue) };
  const xml = {
    root: { element: "doc" },
    rules: [
      { kind: "element", name: ["v"], to: "v" },
      { kind: "attribute", name: ["a"], to: "a" },
    ],
  };
  return {
    lml_bundle: 1,
    roots: [`${name}@default`],
    models: {
      [`${name}@default`]: {
        lml: 2, model: name, register: "default", attributes,
        mappings: { json: mapping, yaml: mapping, xml },
      },
    } as never,
    value_types: {},
    capabilities: ["json", "yaml", "xml"],
  };
}

const main = bundle([float("v", { default: { present: true, value: "0.71" } }), float("a")]);

function generateInto(b: Bundle): string {
  const dir = mkdtempSync(join(tmpdir(), "lml-float-"));
  created.push(dir);
  const contractsModule = "./contracts-shim.js";
  const emitters = [
    createKeyValueEmitter("json", { contractsModule }),
    createKeyValueEmitter("yaml", { contractsModule }),
    ...(xmlAvailable ? [createXmlEmitter({ contractsModule })] : []),
  ];
  const files = generateModelsWith(b, { types: {} }, emitters, { contractsModule });
  for (const [path, text] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2022"], module: "NodeNext", moduleResolution: "NodeNext", types: [],
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
      noFallthroughCasesInSwitch: true, noUnusedLocals: true, noUnusedParameters: true,
      verbatimModuleSyntax: true, isolatedModules: true, skipLibCheck: true, noEmit: true,
    },
    include: ["./*.ts", "./json/*.ts", "./yaml/*.ts", "./xml/*.ts"],
  }));
  execFileSync(process.execPath, [join(REPO, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" });
  return dir;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = Record<string, any>;
// The yaml codec takes its library from the caller; JSON text is a YAML subset.
const lib = { parse: (t: string): unknown => JSON.parse(t) as unknown, stringify: (v: unknown): string => JSON.stringify(v) };
const load = async (dir: string): Promise<Loaded> => (await import(pathToFileURL(join(dir, "index.ts")).href)) as Loaded;

function reasonOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { info?: { reason: string } }).info?.reason;
  }
  return undefined;
}
async function reasonOfAsync(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { info?: { reason: string } }).info?.reason;
  }
  return undefined;
}

describe("portable float in generated models and codecs", () => {
  let mod: Loaded;
  it("generates a strict-tsc-clean model with a number field", { timeout: 180_000 }, async () => {
    const dir = generateInto(main);
    expect(readFileSync(join(dir, "models.ts"), "utf8")).toMatch(/readonly v: number/);
    mod = await load(dir);
  });

  it("applies a float default as the exact binary64", () => {
    const doc = new mod["Doc"]({});
    expect(doc.v).toBe(0.71);
  });

  it("validates finite numbers only", () => {
    const Doc = mod["Doc"];
    expect(Doc.validate({ v: 1.5 })).toEqual([]);
    expect(Doc.validate({ v: Number.NaN }).length).toBeGreaterThan(0);
    expect(Doc.validate({ v: Number.POSITIVE_INFINITY }).length).toBeGreaterThan(0);
    expect(Doc.validate({ v: "1.5" }).length).toBeGreaterThan(0);
    expect(Doc.validate({ v: 1n }).length).toBeGreaterThan(0);
  });

  for (const format of ["json", "yaml"] as const) {
    describe(format, () => {
      it("round-trips every Ruby vector byte-for-byte and stays canonical", () => {
        const codec = mod[format].CODECS["Doc@default"];
        for (const { bits, wire } of vectors.encode) {
          const doc = new mod["Doc"]({ v: fromBits(bits) });
          const text: string = codec.stringify(doc, lib);
          expect(text, wire).toContain(wire);
          const back = codec.parse(text, lib);
          expect(Object.is(back.v, fromBits(bits)), wire).toBe(true);
          expect(codec.stringify(back, lib)).toBe(text);
        }
      });

      it("refuses JSON/YAML numbers and non-canonical spellings", () => {
        const codec = mod[format].CODECS["Doc@default"];
        const doc = (v: string): string => `{"v":${v}}`;
        const bad = ['0.5', '1', '"1.0e-05"', '"+0.71"', '".71"', '"1e-5"', '"NaN"', '"Infinity"', '"1.0e500"', '"0.710"'];
        for (const v of bad) expect(reasonOf(() => codec.parse(doc(v), lib)), v).toBe("invalid_document");
        expect(reasonOf(() => codec.parse(doc('"0.5"'), lib))).toBeUndefined();
      });

      it("refuses to encode NaN and Infinity", () => {
        const codec = mod[format].CODECS["Doc@default"];
        for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          expect(() => new mod["Doc"]({ v })).toThrow(/ValidationError|v/);
          // A forged instance that bypassed the constructor still cannot reach the wire.
          const forged = Object.assign(Object.create(mod["Doc"].prototype), { v, a: null });
          expect(reasonOf(() => codec.stringify(forged, lib))).toBe("not_serializable");
        }
      });
    });
  }

  describe.skipIf(!xmlAvailable)("xml", () => {
    it("round-trips every Ruby vector as element text and attribute text", async () => {
      const codec = mod["xml"].CODECS["Doc@default"];
      for (const { bits, wire } of vectors.encode) {
        const n = fromBits(bits);
        const text: string = await codec.stringify(new mod["Doc"]({ v: n, a: n }));
        expect(text, wire).toContain(`<v>${wire}</v>`);
        expect(text, wire).toContain(`a="${wire}"`);
        const back = await codec.parse(text, lib);
        expect(Object.is(back.v, n) && Object.is(back.a, n), wire).toBe(true);
      }
    });

    it("refuses non-canonical spellings in text and attributes", async () => {
      const codec = mod["xml"].CODECS["Doc@default"];
      for (const bad of ["1.0e-05", "+0.71", ".71", "1e-5", "NaN", "Infinity", "1"]) {
        expect(await reasonOfAsync(() => codec.parse(`<doc><v>${bad}</v></doc>`)), bad).toBe("invalid_document");
        expect(await reasonOfAsync(() => codec.parse(`<doc a="${bad}"/>`)), bad).toBe("invalid_document");
      }
    });
  });
});

describe("float generation refusals", () => {
  const gen = (b: Bundle): void => {
    generateModelsWith(b, { types: {} }, [createKeyValueEmitter("json")], {});
  };
  const code = (b: Bundle): string | undefined => reasonOf(() => gen(b));
  it("refuses non-canonical float defaults and keeps double unsupported", () => {
    for (const value of ["1.0e-05", "+0.71", "1e-5", "NaN", 0.5, 1]) {
      expect(code(bundle([float("v", { default: { present: true, value } })])), String(value)).toBeDefined();
    }
    const dbl = bundle([{ ...(float("v") as object), type: { kind: "builtin", name: "double" } }]);
    expect(code(dbl)).toBe("unsupported_type");
  });
});

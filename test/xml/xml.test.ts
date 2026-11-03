import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import type { Bindings, Bundle, ErrorCode } from "../../src/contracts.js";
import { generateModelsWith } from "../../src/generator/index.js";
import { createXmlEmitter, xmlEmitter } from "../../src/xml/index.js";

// moxml-ts is a git dependency whose install fetches wasm (see package.json).
// Where it is absent (an install without the dependency) the runtime cases are
// reported as skipped, never as passed; emitter-only cases still run.
const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("moxml-ts")'], { encoding: "utf8" });
const available = probe.status === 0;

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
  expected_data?: unknown;
  expected_error?: string;
  divergence?: string;
  ruby_class?: string;
  ruby_xml?: string;
}
interface Oracle {
  bundle: Bundle;
  cases: OracleCase[];
}
const oracle = JSON.parse(readFileSync(join(FIXTURES, "oracle.json"), "utf8")) as Oracle;
const NONE: Bindings = { types: {} };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = Record<string, any>;

function generateInto(bundle: Bundle, bindings: Bindings = NONE): string {
  const dir = mkdtempSync(join(tmpdir(), "lml-xml-"));
  created.push(dir);
  const contractsModule = "./contracts-shim.js";
  const files = generateModelsWith(bundle, bindings, [createXmlEmitter({ contractsModule })], { contractsModule });
  for (const [path, text] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function tscCheck(dir: string): void {
  const config = {
    compilerOptions: {
      target: "ES2022", lib: ["ES2022"], module: "NodeNext", moduleResolution: "NodeNext", types: [],
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
      noFallthroughCasesInSwitch: true, noUnusedLocals: true, noUnusedParameters: true,
      verbatimModuleSyntax: true, isolatedModules: true, skipLibCheck: true, noEmit: true,
    },
    include: ["./*.ts", "./xml/*.ts"],
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

async function infoOf(run: () => Promise<unknown> | unknown): Promise<LmlError["info"] | undefined> {
  try {
    await run();
  } catch (error) {
    const info = (error as { name?: string; info?: LmlError["info"] }).info;
    if ((error as Error).name === "LmlError" && info !== undefined) return info;
    throw error;
  }
  return undefined;
}

/** The neutral dump shared with generate.rb. */
function dump(value: unknown): unknown {
  if (value === null || value === undefined || typeof value === "symbol") return null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.length === 0 ? null : value.map(dump);
  if (typeof value === "object" && "constructor" in value && Array.isArray((value.constructor as { memberNames?: unknown }).memberNames)) {
    const names = (value.constructor as unknown as { memberNames: string[] }).memberNames;
    const record = value as Record<string, unknown>;
    // Ruby has no attribute named like a token list: it is dumped last.
    const out: Record<string, unknown> = {};
    for (const name of [...names.filter((n) => n !== "__lml_content"), ...names.filter((n) => n === "__lml_content")]) {
      // An ordered-content token list stays [] when empty (Ruby does too); other empty lists dump as null.
      const member = record[name];
      out[name] = name === "__lml_content" && Array.isArray(member) && member.length === 0 ? [] : dump(member);
    }
    return out;
  }
  return value;
}

function reorder(expected: unknown): unknown {
  return expected;
}

// How the TypeScript reader deliberately differs from Ruby on a case, by id.
type Override = { error: ErrorCode; attribute?: string } | { data: unknown };
const OVERRIDES: Record<string, Override> = {
  // Ruby matches a prefixed attribute by local name regardless of namespace.
  "person-prefixed-attribute-lenient": { data: { id: null, lang: null, name: null, nick: null, tags: null, addr: null, age: null, ni: null, nb: null, ee: null } },
  // Ruby accepts any root element name or namespace.
  "person-wrong-root": { error: "invalid_document" },
  "person-wrong-namespace": { error: "invalid_document" },
  // Ruby reads an unparseable integer as nil.
  "person-bad-integer": { error: "invalid_document", attribute: "age" },
  // Ruby falls back to the declared type for an unknown discriminator value.
  "kennel-poly-unknown-kind": { error: "unknown_discriminator" },
};

describe("emitter output", () => {
  it("writes only xml/{codecs,index,runtime}.ts, deterministically, with no any/eval", () => {
    const a = xmlEmitter.emit(oracle.bundle, NONE);
    const b = xmlEmitter.emit(structuredClone(oracle.bundle), NONE);
    expect([...a.keys()]).toEqual(["xml/codecs.ts", "xml/index.ts", "xml/runtime.ts"]);
    expect([...b]).toEqual([...a]);
    const all = [...a.values()].join("\n");
    expect(all).not.toMatch(/: any\b|<any>|\bas any\b/);
    expect(all).not.toMatch(/\beval\(|new Function|import\(/);
    expect(xmlEmitter.name).toBe("xml");
  });

  it("emits a reader, writer and codec for every Ruby-mapped model", () => {
    const codecs = xmlEmitter.emit(oracle.bundle, NONE).get("xml/codecs.ts") ?? "";
    for (const name of ["Person", "Plain", "Para", "Ord", "Kennel", "Animal", "Dog", "Addr"]) {
      expect(codecs, name).toMatch(new RegExp(`export function read\\w*${name}\\(`));
      expect(codecs, name).toMatch(new RegExp(`export function write\\w*${name}\\(`));
    }
  });
});

function refusal(edit: (draft: any) => void): () => void { // eslint-disable-line @typescript-eslint/no-explicit-any
  return () => {
    const draft = structuredClone(oracle.bundle) as never;
    edit(draft);
    xmlEmitter.emit(draft, NONE);
  };
}

describe("generation refusals name the mapping", () => {
  const PERSON = "XmlOracle::Person@default";
  const cases: [string, (d: any) => void, ErrorCode][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["unknown mapping-level key", (d) => { d.models[PERSON].mappings.xml.surprise = true; }, "unsupported_mapping"],
    ["unknown rule-level key", (d) => { d.models[PERSON].mappings.xml.rules[0].surprise = 1; }, "unsupported_mapping"],
    ["rule on an unknown attribute", (d) => { d.models[PERSON].mappings.xml.rules[0].to = "ghost"; }, "dangling_reference"],
    ["render policy outside the XML set", (d) => { d.models[PERSON].mappings.xml.rules[2].render.nil = "sideways"; }, "unsupported_mapping"],
    ["a namespace that is not one of the three modes", (d) => { d.models[PERSON].mappings.xml.rules[2].namespace = { mode: "blend" }; }, "invalid_document"],
    ["an ordered mapping without the ordered_content member", (d) => { delete d.models["XmlOracle::Para@default"].ordered_content; }, "invalid_ordered_content"],
    ["a collection XML attribute", (d) => { d.models[PERSON].mappings.xml.rules.find((r: any) => r.kind === "attribute").to = "tags"; }, "unsupported_mapping"], // eslint-disable-line @typescript-eslint/no-explicit-any
  ];
  for (const [label, edit, code] of cases) {
    it(`refuses ${label} as ${code}`, () => {
      try {
        refusal(edit)();
      } catch (error) {
        expect(error).toBeInstanceOf(LmlError);
        const info = (error as LmlError).info;
        expect(info.reason).toBe(code);
        expect(info.format).toBe("xml");
        expect(info.model_id).toBeDefined();
        return;
      }
      throw new Error("expected a refusal");
    });
  }
});

describe.skipIf(!available)("generated XML codecs (moxml-ts)", () => {
  let mod: Loaded;
  it("compiles under strict tsc and loads", { timeout: 180_000 }, async () => {
    const dir = generateInto(oracle.bundle);
    tscCheck(dir);
    mod = await load(dir);
    expect(Object.keys(mod["xml"].CODECS).sort()).toEqual(Object.keys(oracle.bundle.models).sort());
  });

  describe("Ruby oracle reads", () => {
    for (const c of oracle.cases) {
      it(c.id, async () => {
        const codec = mod["xml"].CODECS[c.model_id];
        const override = OVERRIDES[c.id];
        if (c.expected_error !== undefined || (override !== undefined && "error" in override)) {
          const info = await infoOf(async () => dump(await codec.parse(c.input)));
          expect(info, "expected an LmlError").toBeDefined();
          expect(info?.format).toBe("xml");
          expect(info?.model_id).toBeDefined();
          if (override !== undefined && "error" in override) {
            expect(info?.reason).toBe(override.error);
            if (override.attribute !== undefined) {
              expect(info?.attribute).toBe(override.attribute);
              expect(info?.rule).toBe(override.attribute);
              expect(info?.location).toMatch(/^\/\w+\//);
            }
          }
          return;
        }
        const value = await codec.parse(c.input);
        const expected = override !== undefined && "data" in override ? override.data : c.expected_data;
        expect(reorder(dump(value))).toEqual(expected);
        if (c.ruby_class !== undefined && override === undefined) {
          expect(String((value.constructor as { modelId: string }).modelId).split("::").pop()?.split("@")[0]).toBe(c.ruby_class);
        }
      });
    }
  });

  describe("error context", () => {
    it("malformed input names the model, format and input location", async () => {
      const info = await infoOf(() => mod["xml"].CODECS["XmlOracle::Person@default"].parse('<person xmlns="urn:ex"'));
      expect(info).toMatchObject({ reason: "invalid_document", model_id: "XmlOracle::Person@default", format: "xml", location: "/input" });
    });

    it("refuses a DOCTYPE before the parser sees it", async () => {
      const info = await infoOf(() => mod["xml"].CODECS["XmlOracle::Plain@default"].parse('<!DOCTYPE plain [<!ENTITY e "x">]><plain/>'));
      expect(info?.reason).toBe("invalid_document");
      expect(info?.detail).toMatch(/DOCTYPE/);
    });

    it("a nested failure carries the nested model and its path", async () => {
      const info = await infoOf(() => mod["xml"].CODECS["XmlOracle::Kennel@default"].parse('<kennel><pet kind="cat"><name>T</name></pet></kennel>'));
      expect(info).toMatchObject({ reason: "unknown_discriminator", model_id: "XmlOracle::Kennel@default", location: "/kennel/pet[0]/@kind" });
    });

    it("the wrong root names expected and found", async () => {
      const info = await infoOf(() => mod["xml"].CODECS["XmlOracle::Person@default"].parse("<other/>"));
      expect(info?.detail).toMatch(/expected root element person.*found other/);
    });
  });

  describe("writers", () => {
    it("write a Ruby-read value and read it back identically (every oracle case)", async () => {
      let checked = 0;
      for (const c of oracle.cases) {
        if (c.expected_data === undefined || OVERRIDES[c.id] !== undefined) continue;
        const codec = mod["xml"].CODECS[c.model_id];
        const value = await codec.parse(c.input);
        if (c.id === "para-cdata-token") {
          const info = await infoOf(() => codec.stringify(value));
          expect(info?.reason, c.id).toBe("unsupported_mapping");
          expect(info?.detail).toMatch(/CDATA/);
          continue;
        }
        const text: string = await codec.stringify(value);
        // as_nil / as_blank write an empty element for a nil member, which reads back as "";
        // an empty-string member under the default empty policy is omitted and reads back as nil (as in Ruby's own to_xml).
        const expected = structuredClone(c.expected_data) as Record<string, unknown>;
        if (c.model_id === "XmlOracle::Person@default") {
          for (const member of ["id", "lang"]) if (expected[member] === "") expected[member] = null; // empty attribute is omitted
          for (const member of ["ni", "nb"]) expected[member] = expected[member] === null ? "" : null;
        }
        expect(dump(await codec.parse(text)), `${c.id}: ${text}`).toEqual(expected);
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(24);
    });

    it("emits namespaces by prefix and by default declaration", async () => {
      const codec = mod["xml"].CODECS["XmlOracle::Person@default"];
      const value = await codec.parse('<person xmlns="urn:ex" id="1"><name>N</name><addr xmlns="urn:addr"><city>C</city></addr></person>');
      const text: string = await codec.stringify(value);
      expect(text).toContain('xmlns:ex="urn:ex"');
      expect(text).toContain("<ex:name>N</ex:name>");
      expect(text).toContain('xmlns:ad="urn:addr"');
      expect(text).toContain("<ad:addr");
    });

    it("applies nil and empty policies like Ruby for an absent and an empty member", async () => {
      const codec = mod["xml"].CODECS["XmlOracle::Person@default"];
      const value = await codec.parse('<person xmlns="urn:ex"><ee/></person>');
      const text: string = await codec.stringify(value);
      expect(text).toContain("<ex:ni");
      expect(text).toContain('nil="true"');
      expect(text).toMatch(/<ex:nb\b[^>]*\/>/);
      expect(text).toMatch(/<ex:ee\b[^>]*\/>/);
      expect(text).not.toContain("<ex:age");
    });

    it("writes mixed content in token order, never regrouped", async () => {
      const codec = mod["xml"].CODECS["XmlOracle::Para@default"];
      const text: string = await codec.stringify(await codec.parse("<p>a<b>x</b>c<i>y</i>d<b>z</b></p>"));
      expect(text).toBe("<p>a<b>x</b>c<i>y</i>d<b>z</b></p>");
    });

    it("writes element-only ordered content in token order", async () => {
      const codec = mod["xml"].CODECS["XmlOracle::Ord@default"];
      const text: string = await codec.stringify(await codec.parse("<ord><c>1</c><a>2</a><c>3</c><a>4</a></ord>"));
      expect(text).toBe("<ord><c>1</c><a>2</a><c>3</c><a>4</a></ord>");
    });

    it("refuses CDATA output by name instead of dropping it", async () => {
      const codec = mod["xml"].CODECS["XmlOracle::Para@default"];
      const info = await infoOf(async () => codec.stringify(await codec.parse("<p>a<![CDATA[raw]]></p>")));
      expect(info).toMatchObject({ reason: "unsupported_mapping", format: "xml", model_id: "XmlOracle::Para@default" });
    });
  });
});

describe.skipIf(!available)("hand-written bundles: rule namespaces the Ruby DSL cannot declare", () => {
  const model = (xml: unknown, attributes: unknown[]): Bundle => ({
    lml_bundle: 1,
    roots: ["Doc@default"],
    models: {
      "Doc@default": { lml: 2, model: "Doc", register: "default", attributes, mappings: { xml } },
    } as never,
    value_types: {},
    capabilities: ["xml"],
  });
  const str = (name: string, extra: object = {}): unknown => ({
    name, type: { kind: "builtin", name: "string" }, required: false, collection: false,
    default: { present: false }, initialize_empty: false, ...extra,
  });
  const element = (name: string, to: string, namespace: unknown, extra: object = {}): unknown =>
    ({ kind: "element", name: [name], to, namespace, ...extra });

  it("honours uri, unqualified and inherit element rules and attribute namespaces", { timeout: 180_000 }, async () => {
    const bundle = model(
      {
        root: { element: "doc" },
        namespace: { mode: "uri", uri: "urn:doc", prefix: "d" },
        rules: [
          element("a", "a", { mode: "inherit" }),
          element("b", "b", { mode: "uri", uri: "urn:b", prefix: "bb" }),
          element("c", "c", { mode: "unqualified" }),
          { kind: "attribute", name: ["x"], to: "x", namespace: { mode: "uri", uri: "urn:attr", prefix: "at" } },
          { kind: "attribute", name: ["y"], to: "y", namespace: { mode: "inherit" } },
        ],
      },
      [str("a"), str("b"), str("c"), str("x"), str("y")],
    );
    const dir = generateInto(bundle);
    tscCheck(dir);
    const codec = (await load(dir))["xml"].CODECS["Doc@default"];
    const xml =
      '<d:doc xmlns:d="urn:doc" xmlns:at="urn:attr" xmlns:o="urn:other" at:x="X" y="Y">' +
      '<d:a>A</d:a><bb:b xmlns:bb="urn:b">B</bb:b><c>C</c></d:doc>';
    expect(dump(await codec.parse(xml))).toEqual({ a: "A", b: "B", c: "C", x: "X", y: "Y" });
    // Wrong namespaces never match: b in the wrong URI, c qualified, x unqualified, y namespaced.
    const wrong =
      '<d:doc xmlns:d="urn:doc" xmlns:at="urn:attr" x="no" at:y="no"><d:b>no</d:b><d:c>no</d:c></d:doc>';
    expect(dump(await codec.parse(wrong))).toEqual({ a: null, b: null, c: null, x: null, y: null });
    // Round trip through the writer keeps every namespace.
    const written: string = await codec.stringify(await codec.parse(xml));
    expect(written).toContain('xmlns:bb="urn:b"');
    expect(written).toContain("at:x=");
    expect(dump(await codec.parse(written))).toEqual({ a: "A", b: "B", c: "C", x: "X", y: "Y" });
  });

  it("resolves a QName value through the in-scope prefix bindings", { timeout: 180_000 }, async () => {
    const bundle = model(
      { root: { element: "doc" }, rules: [element("q", "q", { mode: "inherit" })] },
      [{ name: "q", type: { kind: "builtin", name: "qname" }, required: false, collection: false, default: { present: false }, initialize_empty: false }],
    );
    const codec = (await load(generateInto(bundle)))["xml"].CODECS["Doc@default"];
    const value = await codec.parse('<doc xmlns:p="urn:p"><q>p:thing</q></doc>');
    expect(value.q).toEqual({ namespace: "urn:p", local: "thing" });
    const bad = await infoOf(() => codec.parse("<doc><q>zz:thing</q></doc>"));
    expect(bad).toMatchObject({ reason: "invalid_document", attribute: "q", rule: "q" });
  });

  it("refuses a hash-typed rule and an unprefixed namespaced attribute writer", { timeout: 180_000 }, async () => {
    const hash = model(
      { root: { element: "doc" }, rules: [element("h", "h", { mode: "inherit" })] },
      [{ name: "h", type: { kind: "builtin", name: "hash" }, required: false, collection: false, default: { present: false }, initialize_empty: false }],
    );
    expect(() => xmlEmitter.emit(hash, NONE)).toThrow(/hash values have no XML text form/);
    const noPrefix = model(
      { root: { element: "doc" }, rules: [{ kind: "attribute", name: ["x"], to: "x", namespace: { mode: "uri", uri: "urn:attr" } }] },
      [str("x")],
    );
    const codec = (await load(generateInto(noPrefix)))["xml"].CODECS["Doc@default"];
    const value = await codec.parse('<doc xmlns:q="urn:attr" q:x="1"/>');
    expect(value.x).toBe("1");
    const info = await infoOf(() => codec.stringify(value));
    expect(info).toMatchObject({ reason: "unsupported_mapping", format: "xml" });
    expect(info?.detail).toMatch(/declares no prefix/);
  });
});

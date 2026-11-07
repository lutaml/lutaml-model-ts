import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Bundle } from "../../src/contracts.js";
import { generateModelsWith } from "../../src/generator/index.js";
import { createXmlEmitter } from "../../src/xml/index.js";

// The any_attribute rule (Ruby map_all_attributes, 02g). Expected values are Ruby's own output, measured with
// fixtures/any_attribute.generator.rb (`bundle exec ruby -Ilib` in the lutaml-model wave1 worktree).
const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("moxml-ts")'], { encoding: "utf8" });
const available = probe.status === 0;
const REPO = resolve(import.meta.dirname, "../..");
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const doc = (rules: unknown[], ns = true, extra: unknown[] = []) => ({
  lml: 2, model: "N", register: "default",
  attributes: [
    { name: "id", type: { kind: "builtin", name: "string" }, required: false, collection: false, default: { present: false }, initialize_empty: false },
    { name: "other", type: { kind: "builtin", name: "hash" }, required: false, collection: false, default: { present: false }, initialize_empty: false },
    ...extra,
  ],
  mappings: { xml: { root: { element: "n" }, ...(ns ? { namespace: { mode: "uri", uri: "d", prefix: null } } : {}), rules } },
});
const ID = { kind: "attribute", name: ["id"], to: "id", render: { nil: "omit", empty: "omit", default: false }, namespace: { mode: "inherit" } };
const ANY = { kind: "any_attribute", to: "other" };
const bundleOf = (d: unknown): Bundle =>
  ({ lml_bundle: 1, roots: ["N@default"], models: { "N@default": d }, value_types: {}, capabilities: {} }) as unknown as Bundle;

async function build(d: unknown): Promise<{ parse(t: string): Promise<{ id?: unknown; other?: unknown }>; stringify(v: unknown): Promise<string>; N: new (init: unknown) => unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "lml-any-"));
  created.push(dir);
  const contractsModule = "./contracts-shim.js";
  const files = generateModelsWith(bundleOf(d), { types: {} }, [createXmlEmitter({ contractsModule })], { contractsModule });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", lib: ["ES2022"], module: "NodeNext", moduleResolution: "NodeNext", types: [], strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, isolatedModules: true, skipLibCheck: true, noEmit: true },
    include: ["./*.ts", "./xml/*.ts"],
  }));
  execFileSync(process.execPath, [join(REPO, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { stdio: "pipe" });
  const mod = (await import(pathToFileURL(join(dir, "index.ts")).href)) as { xml: { CODECS: Record<string, never> }; N: never };
  const codec = mod.xml.CODECS["N@default"] as never as { parse(t: string): Promise<{ id?: unknown; other?: unknown }>; stringify(v: unknown): Promise<string> };
  return { parse: (t) => codec.parse(t), stringify: (v) => codec.stringify(v), N: Object.values(mod).find((v) => typeof v === "function" && (v as { modelId?: string }).modelId === "N@default") as never };
}

describe.skipIf(!available)("any_attribute (map_all_attributes), Ruby 02g golden cases", () => {
  it("reads unclaimed attributes by local name, prefix stripped, xmlns excluded", { timeout: 120_000 }, async () => {
    const c = await build(doc([ID, ANY]));
    const v = await c.parse('<n xmlns:x="u" xmlns="d" id="1" x:a="2" b="3" xml:lang="en"/>');
    expect(v.id).toBe("1");
    expect({ ...(v.other as object) }).toEqual({ a: "2", b: "3", lang: "en" }); // Ruby: {"a"=>"2","b"=>"3","lang"=>"en"}
    expect(Object.keys(v.other as object)).toEqual(["a", "b", "lang"]);
  });

  it("leaves the hash unset when no attribute qualifies", async () => {
    const c = await build(doc([ID, ANY]));
    expect(typeof (await c.parse('<n id="1"/>')).other).toBe("symbol"); // Ruby: UninitializedClass, not {}
  });

  it("lets a later attribute overwrite an earlier one with the same local name and excludes schemaLocation", async () => {
    const c = await build(doc([ID, ANY]));
    const v = await c.parse('<n xmlns:x="u" xmlns:y="u" x:a="1" a="2" y:s="v" schemaLocation="z"/>');
    expect({ ...(v.other as object) }).toEqual({ a: "2", s: "v" }); // Ruby: {"a"=>"2","s"=>"v"}
  });

  it("writes each entry as an unprefixed attribute after the mapped ones (nil values cannot occur in a neutral hash)", async () => {
    const c = await build(doc([ID, ANY], false));
    const text = await c.stringify(new c.N({ id: "1", other: { a: "2", n: 3, schemaLocation: "s" } }));
    expect(text).toBe('<n id="1" a="2" n="3" schemaLocation="s"/>'); // Ruby, same input
    const lang = await c.stringify(new c.N({ id: "1", other: { a: "2", b: "3", lang: "en" } }));
    expect(lang).toBe('<n id="1" a="2" b="3" lang="en"/>');
  });

  it("refuses a rule with extra keys and a non-hash target by name", async () => {
    await expect(build(doc([ID, { ...ANY, name: ["x"] }]))).rejects.toMatchObject({ info: { reason: "unsupported_mapping" } });
    await expect(build(doc([ID, { kind: "any_attribute", to: "id" }]))).rejects.toMatchObject({ info: { reason: "unsupported_mapping" } });
  });
});

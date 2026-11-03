import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Bundle } from "../../src/contracts.js";
import { loadBundle } from "../../src/lml/index.js";
import { generateModelsWith } from "../../src/generator/index.js";
import { createXmlEmitter } from "../../src/xml/index.js";
import type { Tree } from "../../scripts/mml/lib.mjs";
import { canonicalTree, dump, emptyNormal, firstDiff, refusalClass, stable, stripWs } from "../../scripts/mml/lib.mjs";

// Generated mml-ts (from the real mml LML graphs) replays the Ruby oracle: the
// serialized tree and the model data must equal what Ruby mml 2.4.7 produced.
// Where moxml-ts is absent the generated cases are skipped, never passed.
const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("moxml-ts")'], { encoding: "utf8" });
const available = probe.status === 0;

const REPO = resolve(import.meta.dirname, "../..");
const FIXTURES = join(import.meta.dirname, "fixtures");
// The nested-Math graphs are 4 MB each and not committed here.
const EXTERNAL = process.env["LML_MML_FIXTURES"] ?? "/Users/umerhassan/lutaml/lutaml-model-1033-worktrees/wave1/spec/fixtures/lml_mml";
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

interface OracleCase {
  id: string;
  input: string;
  model_id: string;
  expected: { data: unknown; output: string; tree: unknown };
}
const cases = (JSON.parse(readFileSync(join(FIXTURES, "oracle.json"), "utf8")) as { cases: OracleCase[] }).cases;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loaded = Record<string, any>;

function generateInto(bundle: Bundle): string {
  const dir = mkdtempSync(join(tmpdir(), "lml-mml-"));
  created.push(dir);
  const contractsModule = "./contracts-shim.js";
  const files = generateModelsWith(bundle, { types: {} }, [createXmlEmitter({ contractsModule })], { contractsModule });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
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
    include: ["./*.ts", "./xml/*.ts"],
  }));
  try {
    execFileSync(process.execPath, [join(REPO, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const out = error as { stdout?: string; stderr?: string };
    throw new Error(`tsc failed:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
  }
  return dir;
}

const graphs: { id: string; version: "v3" | "v4"; kind: "mi-mixed" | "math-nested"; path: string }[] = (["v3", "v4"] as const).flatMap((version) => [
  { id: `${version}-mi-mixed`, version, kind: "mi-mixed" as const, path: join(FIXTURES, `${version}-mi-mixed.json`) },
  { id: `${version}-math-nested`, version, kind: "math-nested" as const, path: join(EXTERNAL, `${version}-math-nested.json`) },
]);

describe("comparison helpers", () => {
  it("drops formatting whitespace between elements but never trims or merges real text", () => {
    const pretty = '<a xmlns="urn:x">\n  <b> x </b>\n</a>';
    expect(available).toBeDefined();
    return Promise.all([canonicalTree(pretty), canonicalTree('<a xmlns="urn:x"><b> x </b></a>'), canonicalTree('<a xmlns="urn:x"><b>x</b></a>')]).then(([p, c, trimmed]) => {
      expect(stable(p)).not.toBe(stable(c));
      expect(stable(stripWs(p))).toBe(stable(stripWs(c)));
      expect(stable(stripWs(c))).not.toBe(stable(stripWs(trimmed)));
    });
  });

  it("detects a changed attribute and reports the first differing path", () => {
    expect(firstDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe("/a/1/b: ruby=2 ts=3");
    expect(stable(emptyNormal({ x: [], y: { state: "absent" }, z: null }))).toBe(stable({ x: null, y: null, z: null }));
    expect(stable(emptyNormal({ x: [""] }))).not.toBe(stable(emptyNormal({ x: null })));
  });

  it("names refusals instead of lumping them", () => {
    expect(refusalClass({ reason: "invalid_document", detail: "DOCTYPE is not supported" })).toBe("refused: doctype");
    expect(refusalClass({ reason: "invalid_document", detail: "expected root element math in urn:a, found math" })).toMatch(/^refused: root\/namespace/);
  });
});

describe.skipIf(!available)("generated mml-ts replays the Ruby mml 2.4.7 oracle", () => {
  for (const graph of graphs) {
    const present = existsSync(graph.path);
    describe.skipIf(!present)(`${graph.id} (${present ? "graph present" : `graph missing: ${graph.path}`})`, () => {
      let mod: Loaded;
      it("generates, compiles under strict tsc and loads", { timeout: 240_000 }, async () => {
        const bundle: Bundle = loadBundle(readFileSync(graph.path), "json");
        const dir = generateInto(bundle);
        mod = (await import(pathToFileURL(join(dir, "index.ts")).href)) as Loaded;
        expect(Object.keys(mod["xml"].CODECS).length).toBe(Object.keys(bundle.models).length);
      });

      for (const c of cases.filter((x) => x.id === graph.id)) {
        it(`${c.id}: data and serialized tree equal Ruby`, async () => {
          const codec = mod["xml"].CODECS[c.model_id];
          const value = await codec.parse(c.input);
          // Ruby reads an absent collection as [] and TS as null: compared after emptyNormal (docs/mml-pilot.md, class "empty collection").
          expect(firstDiff(emptyNormal(c.expected.data), emptyNormal(dump(value)))).toBeNull();
          const out = await codec.stringify(value);
          // Ruby pretty-prints; formatting whitespace between elements is not compared (stripWs never trims text).
          expect(stable(stripWs(await canonicalTree(out)))).toBe(stable(stripWs(c.expected.tree as Tree)));
          // And the written XML reads back to the same model.
          expect(firstDiff(dump(value), dump(await codec.parse(out)))).toBeNull();
        });
      }
    });
  }
});

describe("corpus report (scripts/mml/run.mjs), when a run exists", () => {
  const dir = join(REPO, "test/mml/.tmp/mml-run");
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => /^results-.*\.json$/.test(n)) : [];
  it.skipIf(files.length === 0)("every row has a known outcome and non-pass rows are classified", () => {
    const known = new Set(["pass", "refused", "refused_by_ts_only", "both_refuse", "mismatch"]);
    for (const file of files) {
      const report = JSON.parse(readFileSync(join(dir, file), "utf8")) as { results: { outcome: string; cls: string }[] };
      for (const row of report.results) {
        expect(known.has(row.outcome), row.outcome).toBe(true);
        expect(row.cls.length).toBeGreaterThan(0);
        expect(row.cls.startsWith("other:"), `${file}: unclassified mismatch ${row.cls}`).toBe(false);
      }
    }
  });
});

#!/usr/bin/env node
// Generates mml-ts (TypeScript models + XML codecs) from the LML mml graphs and
// compiles it to JavaScript. Output: <out>/<v3|v4>/{ts,js}. Requires `npm run build`.
//
//   node scripts/mml/generate.mjs [--fixtures DIR] [--out DIR]
//
// --fixtures defaults to $LML_MML_FIXTURES, then the lutaml-model wave1 worktree.
// Exit: 0 generated and compiled, 1 failure.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { generateModelsWith } = await import(join(REPO, "dist/index.js"));
const { loadBundle } = await import(join(REPO, "dist/lml/index.js"));
const { createXmlEmitter } = await import(join(REPO, "dist/xml/index.js"));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const fixtures = resolve(arg("--fixtures", process.env.LML_MML_FIXTURES ?? "/Users/umerhassan/lutaml/lutaml-model-1033-worktrees/wave1/spec/fixtures/lml_mml"));
const out = resolve(arg("--out", join(REPO, "test/mml/.tmp/mml-gen")));

for (const version of ["v3", "v4"]) {
  const bytes = readFileSync(join(fixtures, `${version}-math-nested.json`));
  const bundle = loadBundle(bytes, "json");
  const contractsModule = "../contracts-shim.js";
  const files = generateModelsWith(bundle, { types: {} }, [createXmlEmitter({ contractsModule })], { contractsModule });
  const dir = join(out, version);
  rmSync(dir, { recursive: true, force: true });
  const ts = join(dir, "ts");
  for (const [path, text] of files) {
    mkdirSync(dirname(join(ts, path)), { recursive: true });
    writeFileSync(join(ts, path), text);
  }
  // The generated code imports LmlError from this module; a shim keeps the output self-contained.
  copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2022"], module: "NodeNext", moduleResolution: "NodeNext", types: [],
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
      noFallthroughCasesInSwitch: true, noUnusedLocals: true, noUnusedParameters: true,
      verbatimModuleSyntax: true, isolatedModules: true, skipLibCheck: true,
      outDir: "js", rootDir: ".", typeRoots: [],
    },
    include: ["./*.ts", "./ts/**/*.ts"],
  }));
  execFileSync(process.execPath, [join(REPO, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { stdio: "inherit" });
  // moxml-ts resolves from the repository's node_modules.
  try { execFileSync("ln", ["-s", join(REPO, "node_modules"), join(dir, "node_modules")]); } catch { /* exists */ }
  console.log(`${version}: ${Object.keys(bundle.models).length} models, ${files.size} files, compiled under strict tsc`);
}

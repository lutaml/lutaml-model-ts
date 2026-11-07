#!/usr/bin/env node
// Runs real MathML documents through Ruby (Mml::V3/V4) and generated mml-ts and
// reports pass / refused-by-name / mismatch counts per suite. See docs/mml-pilot.md.
//
//   node scripts/mml/generate.mjs                       # once: generated mml-ts
//   node scripts/mml/run.mjs [--corpora DIR] [--out DIR] [--wave1 DIR] [--mml-root DIR]
//                            [--limit N] [--reuse]
//
// Corpora (clone read-only, never committed): DIR/{mml2,mml3,mmlcore}-testsuite
// from github.com/plurimath. Ruby runs in --wave1 (a lutaml-model checkout with
// the LML work) with `bundle exec ruby -Ilib`, against the mml 2.4.7 gem in
// --mml-root (default $LML_MML_ROOT). Nothing is stripped or rewritten except
// in the explicitly labelled "ns-injected" variant. Exit 0 = report written.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const corpora = resolve(arg("--corpora", join(REPO, "test/mml/.tmp/corpora")));
const outDir = resolve(arg("--out", join(REPO, "test/mml/.tmp/mml-run")));
const wave1 = resolve(arg("--wave1", "/Users/umerhassan/lutaml/lutaml-model-1033-worktrees/wave1"));
const mmlRoot = arg("--mml-root", process.env.LML_MML_ROOT ?? "/Users/umerhassan/.rvm/gems/ruby-3.4.8/gems/mml-2.4.7");
const genDir = resolve(arg("--gen", join(REPO, "test/mml/.tmp/mml-gen")));
const limit = Number(arg("--limit", "0"));
const reuse = process.argv.includes("--reuse");
const ALL_SUITES = ["mml2-testsuite", "mml3-testsuite", "mmlcore-testsuite"];
const onlySuite = arg("--suite", undefined);
const reportOnly = process.argv.includes("--report-only"); // re-render report.md from results-*.json
const SUITES = reportOnly ? [] : onlySuite === undefined ? ALL_SUITES : [onlySuite];
// MathML 2 and 3 suites run against Mml::V3, MathML Core against Mml::V4, unless --both-versions.
const PRIMARY = { "mml2-testsuite": "3", "mml3-testsuite": "3", "mmlcore-testsuite": "4" };
const bothVersions = process.argv.includes("--both-versions");
const VERSIONS = ["3", "4"];
const NS = "http://www.w3.org/1998/Math/MathML";

import { canonicalTree, causeOf, squeezeWs, dump, emptyNormal, firstDiff, refusalClass, rubyClass, stable, stripWs } from "./lib.mjs";

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (name.endsWith(".mml")) acc.push(path);
  }
  return acc;
}

function runRuby(version, files, tag) {
  const jsonl = join(outDir, `ruby-v${version}-${tag}.jsonl`);
  if (!(reuse && existsSync(jsonl))) {
    const list = join(outDir, `files-${tag}.txt`);
    writeFileSync(list, files.join("\n") + "\n");
    const r = spawnSync("bundle", ["exec", "ruby", "-Ilib", join(REPO, "scripts/mml/ruby_oracle.rb"), version, list, jsonl], {
      cwd: wave1, env: { ...process.env, LML_MML_ROOT: mmlRoot }, encoding: "utf8", maxBuffer: 1 << 28,
    });
    if (r.status !== 0) throw new Error(`ruby oracle failed (v${version} ${tag}):\n${r.stderr}`);
  }
  return new Map(readFileSync(jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.file, r]));
}

mkdirSync(outDir, { recursive: true });
const suiteOf = new Map();
let all = [];
for (const suite of SUITES) {
  const dir = join(corpora, suite);
  if (!existsSync(dir)) throw new Error(`missing corpus ${dir} (git clone --depth 1 https://github.com/plurimath/${suite})`);
  let files = walk(dir);
  if (limit > 0) files = files.slice(0, limit);
  for (const f of files) suiteOf.set(f, suite);
  all = all.concat(files);
}

// Variant "as-is" runs files untouched. Variant "ns-injected" adds the MathML
// namespace to a root <math> that has none (the only rewrite; written to outDir).
const injectedDir = join(outDir, "injected");
const variants = { "as-is": new Map(all.map((f) => [f, f])), "ns-injected": new Map() };
let hasNs = 0;
for (const f of all) {
  const text = readFileSync(f, "utf8");
  const root = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*(\[[\s\S]*?\])?\s*>/i, "").match(/<math\b[^>]*>/);
  if (root && !/\sxmlns\s*=/.test(root[0])) {
    const target = join(injectedDir, relative(corpora, f));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text.replace(/<math\b/, `<math xmlns="${NS}"`));
    variants["ns-injected"].set(f, target);
  } else hasNs++;
}

const results = [];
for (const version of VERSIONS) {
  const mod = await import(pathToFileURL(join(genDir, `v${version}`, "js/ts/index.js")).href);
  const codec = mod.xml.CODECS[`Mml::V${version}::Math@mml_v${version}`];
  for (const [variant, map] of Object.entries(variants)) {
    const wanted = new Map([...map].filter(([orig]) => bothVersions || PRIMARY[suiteOf.get(orig)] === version));
    if (wanted.size === 0) continue;
    const ruby = runRuby(version, [...wanted.values()], `${onlySuite ?? "all"}-${variant}`);
    for (const [orig, file] of wanted) {
      const r = ruby.get(file);
      const text = readFileSync(file, "utf8");
      const rec = { suite: suiteOf.get(orig), version, variant, file: relative(corpora, orig), comments: /<!--/.test(text) };
      let ts, tsErr;
      const started = performance.now();
      try {
        ts = await codec.parse(text);
      } catch (e) {
        tsErr = e?.info ?? { reason: "crash", detail: `${e?.name}: ${e?.message}` };
      }
      if (!r.ok && tsErr) { rec.outcome = "both_refuse"; rec.cls = `ruby ${rubyClass(r)} | ts ${refusalClass(tsErr)}`; }
      else if (!r.ok) { rec.outcome = "mismatch"; rec.cls = `ruby refuses, ts accepts: ${rubyClass(r)}`; }
      else if (tsErr) { rec.outcome = /DOCTYPE/i.test(tsErr.detail ?? "") ? "refused" : "refused_by_ts_only"; rec.cls = refusalClass(tsErr); rec.detail = tsErr.detail; }
      else {
        try {
          const tsXml = await codec.stringify(ts);
          const rt = await canonicalTree(r.output), tt = await canonicalTree(tsXml);
          const treeExact = stable(rt) === stable(tt);
          const treeWs = treeExact || stable(stripWs(rt)) === stable(stripWs(tt));
          const rd = r.data, td = dump(ts);
          const dataExact = stable(rd) === stable(td);
          const dataNorm = dataExact || stable(emptyNormal(rd)) === stable(emptyNormal(td));
          rec.checks = { treeExact, treeWs, dataExact, dataNorm, bytes: r.output === tsXml };
          if (treeWs && dataNorm) { rec.outcome = "pass"; rec.cls = dataExact ? "pass" : "pass (data equal after empty/absent/null collapse)"; }
          else {
            rec.outcome = "mismatch";
            const dData = dataNorm ? null : firstDiff(emptyNormal(rd), emptyNormal(td));
            const dTree = treeWs ? null : firstDiff(stripWs(rt), stripWs(tt));
            const squeezed = !treeWs && stable(squeezeWs(stripWs(rt))) === stable(squeezeWs(stripWs(tt)));
            rec.cls = causeOf(dData, dTree, squeezed);
            rec.detail = dData ?? dTree;
            if (dData && dTree) rec.detail += ` || tree ${dTree}`;
          }
        } catch (e) {
          rec.outcome = "mismatch"; rec.cls = "ts write/compare failed"; rec.detail = `${e?.info?.detail ?? e?.message}`;
        }
      }
      rec.ms = Math.round(performance.now() - started);
      results.push(rec);
      if (results.length % 250 === 0) console.error(`${results.length} compared (v${version} ${variant})`);
    }
  }
}

if (!reportOnly) writeFileSync(join(outDir, `results-${onlySuite ?? "all"}.json`), JSON.stringify({ mml_version: "2.4.7", suite: onlySuite ?? "all", files: all.length, hasNs, results }, null, 1));
if (process.argv.includes("--no-report")) process.exit(0);

// ---- report
// Per-suite runs write results-<suite>.json; a run without --suite writes results-all.json. Keep one kind per --out.
const merged = readdirSync(outDir).filter((n) => /^results-.*\.json$/.test(n));
const parts = merged.map((n) => JSON.parse(readFileSync(join(outDir, n), "utf8")));
const everything = parts.flatMap((p) => p.results);
const totalFiles = parts.reduce((n, p) => n + p.files, 0);
const totalNs = parts.reduce((n, p) => n + p.hasNs, 0);
const lines = [];
const group = (rows, key) => rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map());
lines.push(`# mml pilot run: ${totalFiles} .mml files (${totalNs} already namespaced), mml 2.4.7\n`);
lines.push("| suite | version | variant | files | pass | refused: doctype | refused by ts only | both refuse | mismatch |");
lines.push("|---|---|---|---|---|---|---|---|---|");
for (const suite of ALL_SUITES) for (const version of VERSIONS) for (const variant of Object.keys(variants)) {
  const rows = everything.filter((r) => r.suite === suite && r.version === version && r.variant === variant);
  if (rows.length === 0) continue;
  const c = (o) => rows.filter((r) => r.outcome === o).length;
  lines.push(`| ${suite} | v${version} | ${variant} | ${rows.length} | ${c("pass")} | ${c("refused")} | ${c("refused_by_ts_only")} | ${c("both_refuse")} | ${c("mismatch")} |`);
}
lines.push("\n## Classes (outcome != pass), with one example each\n");
const classes = new Map();
for (const r of everything) {
  if (r.outcome === "pass") continue;
  const k = `${r.outcome} | ${r.cls}`;
  const e = classes.get(k) ?? { n: 0, example: r };
  e.n++; classes.set(k, e);
}
for (const [k, e] of [...classes].sort((a, b) => b[1].n - a[1].n)) {
  lines.push(`- ${e.n}x ${k}\n    e.g. ${e.example.suite} v${e.example.version} ${e.example.variant} ${e.example.file}${e.example.detail ? `\n    ${e.example.detail.slice(0, 200)}` : ""}`);
}
const passRows = everything.filter((r) => r.outcome === "pass");
const slow = [...everything].sort((a, b) => b.ms - a.ms).slice(0, 5);
lines.push(`\nslowest TS parse+write+compare: ${slow.map((r) => `${r.ms}ms ${r.file}`).join("; ")}`);
lines.push(`\npass: ${passRows.length}; byte-identical output among pass: ${passRows.filter((r) => r.checks.bytes).length}; data exact (no collapse): ${passRows.filter((r) => r.checks.dataExact).length}; tree exact including formatting whitespace: ${passRows.filter((r) => r.checks.treeExact).length}`);
writeFileSync(join(outDir, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));

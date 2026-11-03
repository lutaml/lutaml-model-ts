import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const BUNDLE = join(HERE, "bundle.json");
const BINDINGS = join(HERE, "bindings.json");
const SCRATCH = mkdtempSync(join(REPO, "test/cli/.out-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((stdout += String(c)), true));
  const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((stderr += String(c)), true));
  try {
    return { status: run(args), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe("generate", () => {
  const a = join(SCRATCH, "a");
  const b = join(SCRATCH, "b");

  it("writes models, codecs and a manifest, byte-identically on a second run", () => {
    const one = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--format", "yaml", "--out", a]);
    const two = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--format", "yaml", "--out", b]);
    expect([one.status, two.status]).toEqual([0, 0]);
    expect(one.stdout).toMatch(/^sha256:[0-9a-f]{64}\n$/);
    expect(one.stdout).toBe(two.stdout);
    expect(tree(a)).toEqual(tree(b));
    expect(Object.keys(tree(a))).toEqual(
      expect.arrayContaining(["models.ts", "runtime.ts", "index.ts", "json/codecs.ts", "yaml/codecs.ts", "manifest.json", "manifest.sha256"]),
    );
    expect(readFileSync(join(a, "manifest.sha256"), "utf8")).toBe(one.stdout);
  });

  it("--check passes on fresh output and flags a stale or missing file", () => {
    expect(cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--format", "yaml", "--out", a, "--check"]).status).toBe(0);
    writeFileSync(join(a, "models.ts"), "// edited\n");
    rmSync(join(a, "json/codecs.ts"));
    const stale = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--format", "yaml", "--out", a, "--check"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("stale: models.ts");
    expect(stale.stderr).toContain("missing: json/codecs.ts");
    expect(existsSync(join(a, "json/codecs.ts"))).toBe(false);
  });

  it("generated output compiles under strict tsc against the package sources", () => {
    const out = join(SCRATCH, "compile");
    expect(cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--format", "yaml", "--out", out]).status).toBe(0);
    mkdirSync(out, { recursive: true });
    const up = relative(out, REPO);
    writeFileSync(
      join(out, "tsconfig.json"),
      JSON.stringify({
        extends: `${up}/tsconfig.json`,
        compilerOptions: {
          rootDir: up,
          paths: { "lutaml-model-ts": [`${up}/src/index.ts`], "lutaml-model-ts/exact": [`${up}/src/codecs/exact.ts`] },
        },
        include: ["./**/*.ts"],
      }),
    );
    const tsc = join(REPO, "node_modules/typescript/bin/tsc");
    const r = spawnSync(process.execPath, [tsc, "-p", join(out, "tsconfig.json")], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 60_000);

  it("rejects bad usage with exit 2 and a bad bundle with exit 1", () => {
    expect(cli(["generate", BUNDLE]).status).toBe(2);
    expect(cli(["generate", BUNDLE, "--out", join(SCRATCH, "x"), "--format", "xml"]).status).toBe(2);
    const bad = join(SCRATCH, "bad.json");
    writeFileSync(bad, '{"lml_bundle": 99}');
    const r = cli(["generate", bad, "--out", join(SCRATCH, "y")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unsupported_version");
    expect(existsSync(join(SCRATCH, "y"))).toBe(false);
  });

  it("keeps check-version and version working", () => {
    expect(cli(["version"]).stdout).toContain("manifest: 1");
    expect(cli(["check-version", BUNDLE]).stdout).toBe("ok: bundle\n");
  });
});

void execFileSync;

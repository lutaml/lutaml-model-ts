import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRATCH = mkdtempSync(join(REPO, "test/conformance/.min-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("float runtime source survives a minified generator", () => {
  it("emits evaluable code that does not reference renamed identifiers", () => {
    const entry = join(SCRATCH, "entry.ts");
    const out = join(SCRATCH, "out.mjs");
    writeFileSync(
      entry,
      `import { floatRuntimeSource } from ${JSON.stringify(join(REPO, "src/codecs/float-source.ts"))};\nprocess.stdout.write(floatRuntimeSource());\n`,
    );
    execFileSync(join(REPO, "node_modules/.bin/rolldown"), [entry, "--minify", "-f", "esm", "-o", out], { stdio: "pipe" });
    const emitted = execFileSync("node", [out], { encoding: "utf8" });
    const js = ts.transpileModule(emitted, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const api = new Function(`${js}\nreturn { floatWire, canonicalFloat };`)() as {
      floatWire: (v: number) => string;
      canonicalFloat: (v: unknown) => boolean;
    };
    expect(api.floatWire(0.1)).toBe("0.1");
    expect(api.canonicalFloat("0.1")).toBe(true);
    expect(api.canonicalFloat("0.10")).toBe(false);
  });
});

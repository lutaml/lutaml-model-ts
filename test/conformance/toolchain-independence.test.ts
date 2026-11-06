import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateArtifacts } from "../../src/artifacts/index.js";
import type { Bindings } from "../../src/contracts.js";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../cli");
const PINNED = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "expected-digest.txt"), "utf8").trim();

describe("generated runtime bytes do not depend on the toolchain", () => {
  it("vitest (esbuild) generates the digest that tsc's dist/cli.js generated (CI cmp's dist against the same pin)", () => {
    const result = generateArtifacts({
      bundleBytes: readFileSync(join(CLI_DIR, "bundle.json")),
      bundleFormat: "json",
      bindings: JSON.parse(readFileSync(join(CLI_DIR, "bindings.json"), "utf8")) as Bindings,
      formats: ["json", "yaml"],
    });
    expect(result.manifestSha256).toBe(PINNED);
  });
});

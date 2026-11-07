import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli.js";
import { generateArtifacts, LmlError, verifyArtifacts, verifyBundleChecksum } from "../../src/index.js";
import type { Bindings } from "../../src/index.js";
import { bundleChecksum, loadBundle } from "../../src/lml/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "bundle.json");
const BINDINGS = join(HERE, "bindings.json");
const SCRATCH = mkdtempSync(join(HERE, ".verify-"));
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

let counter = 0;
function fresh(): { dir: string; digest: string } {
  const dir = join(SCRATCH, `out-${counter++}`);
  const r = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--out", dir]);
  expect(r.status).toBe(0);
  return { dir, digest: r.stdout.trim() };
}
const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof LmlError) return `${e.info.reason}|${e.info.detail}`;
    throw e;
  }
  return undefined;
};

describe("verify", () => {
  it("accepts fresh output and rejects a wrong pin", () => {
    const { dir, digest } = fresh();
    expect(cli(["verify", "artifacts", dir, "--expected-sha256", digest]).status).toBe(0);
    const bad = cli(["verify", "artifacts", dir, "--expected-sha256", `sha256:${"0".repeat(64)}`]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("checksum_mismatch");
  });

  it("raises checksum_mismatch for a changed listed file", () => {
    const { dir, digest } = fresh();
    writeFileSync(join(dir, "models.ts"), `${readFileSync(join(dir, "models.ts"), "utf8")}// x\n`);
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^checksum_mismatch\|models\.ts/);
  });

  it("names a missing file", () => {
    const { dir, digest } = fresh();
    rmSync(join(dir, "models.ts"));
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|models\.ts/);
  });

  it("names an extra file", () => {
    const { dir, digest } = fresh();
    writeFileSync(join(dir, "stale.ts"), "x");
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|.*stale\.ts/);
  });

  it("refuses a symlink in place of a listed file", () => {
    const { dir, digest } = fresh();
    const text = readFileSync(join(dir, "index.ts"));
    writeFileSync(join(SCRATCH, "real-index.ts"), text);
    rmSync(join(dir, "index.ts"));
    symlinkSync(join(SCRATCH, "real-index.ts"), join(dir, "index.ts"));
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|index\.ts/);
  });

  it("refuses a FIFO in place of a listed file without opening it", () => {
    const { dir, digest } = fresh();
    rmSync(join(dir, "index.ts"));
    execFileSync("mkfifo", [join(dir, "index.ts")]);
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|index\.ts is not a regular file/);
    const r = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--out", dir, "--check"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stale: index.ts");
  });

  it("reports an empty extra directory", () => {
    const { dir, digest } = fresh();
    mkdirSync(join(dir, "empty"));
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|.*empty\//);
    const r = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--out", dir, "--check"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("extra: empty/");
  });

  it("compares optional pins", () => {
    const { dir, digest } = fresh();
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest, generatorVersion: "other/0" }))).toMatch(/^checksum_mismatch\|generator_version/);
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest, lmlChecksum: `sha256:${"1".repeat(64)}` }))).toMatch(/^checksum_mismatch\|lml_checksum/);
  });

  it("verifies a bundle checksum through API and CLI", () => {
    const sum = bundleChecksum(loadBundle(readFileSync(BUNDLE), "json"));
    expect(verifyBundleChecksum(readFileSync(BUNDLE), "json", sum)).toBe(sum);
    expect(reason(() => verifyBundleChecksum(readFileSync(BUNDLE), "json", `sha256:${"0".repeat(64)}`))).toMatch(/^checksum_mismatch/);
    expect(cli(["verify", "bundle", BUNDLE, "--expected-sha256", sum]).status).toBe(0);
    const bad = cli(["verify", "bundle", BUNDLE, "--expected-sha256", `sha256:${"0".repeat(64)}`]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("checksum_mismatch");
    expect(cli(["verify", "bundle", BUNDLE]).status).toBe(2);
  });
});

describe("generate --check extras and runtime pin", () => {
  it("fails and names an extra file the generator would not write", () => {
    const { dir } = fresh();
    mkdirSync(join(dir, "old"));
    writeFileSync(join(dir, "old/leftover.ts"), "x");
    const r = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--out", dir, "--check"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("extra: old/leftover.ts");
  });

  it("fails when a listed file is a symlink, as verify does", () => {
    const { dir } = fresh();
    writeFileSync(join(SCRATCH, "real-index2.ts"), readFileSync(join(dir, "index.ts")));
    rmSync(join(dir, "index.ts"));
    symlinkSync(join(SCRATCH, "real-index2.ts"), join(dir, "index.ts"));
    const r = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--out", dir, "--check"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stale: index.ts");
  });

  it("pins the emitted runtime bytes, not only name and version", () => {
    const input = { bundleBytes: readFileSync(BUNDLE), bundleFormat: "json" as const, bindings: JSON.parse(readFileSync(BINDINGS, "utf8")) as Bindings };
    const a = generateArtifacts(input);
    const b = generateArtifacts({ ...input, contractsModule: "other-contracts" });
    const pin = (s: typeof a): string => (s.manifest.dependencies.find((d) => d.name === "lutaml-model-ts") as { sha256: string }).sha256;
    expect(pin(a)).not.toBe(pin(b));
  });
});

describe("round 3 N5/N6: manifest file kinds and unreadable entries", () => {
  const verifyIn = (dir: string, digest: string) => cli(["verify", "artifacts", dir, "--expected-sha256", digest]);

  it("refuses a manifest.json FIFO without opening it (no hang)", () => {
    const { dir, digest } = fresh();
    rmSync(join(dir, "manifest.json"));
    execFileSync("mkfifo", [join(dir, "manifest.json")]);
    const r = verifyIn(dir, digest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("manifest.json is not a regular file");
  });

  it("refuses a manifest.json symlink, and --check agrees", () => {
    const { dir, digest } = fresh();
    writeFileSync(join(SCRATCH, "outside-manifest.json"), readFileSync(join(dir, "manifest.json")));
    rmSync(join(dir, "manifest.json"));
    symlinkSync(join(SCRATCH, "outside-manifest.json"), join(dir, "manifest.json"));
    const r = verifyIn(dir, digest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("manifest.json is a symlink");
    const c = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--out", dir, "--check"]);
    expect(c.status).toBe(1);
  });

  it("refuses a manifest.sha256 symlink that holds the wrong digest, and a FIFO", () => {
    const { dir, digest } = fresh();
    expect(existsSync(join(dir, "manifest.sha256"))).toBe(true);
    writeFileSync(join(SCRATCH, "wrong.sha256"), "sha256:00\n");
    rmSync(join(dir, "manifest.sha256"));
    symlinkSync(join(SCRATCH, "wrong.sha256"), join(dir, "manifest.sha256"));
    const link = verifyIn(dir, digest);
    expect(link.status).toBe(1);
    expect(link.stderr).toContain("manifest.sha256 is a symlink");
    rmSync(join(dir, "manifest.sha256"));
    execFileSync("mkfifo", [join(dir, "manifest.sha256")]);
    const fifo = verifyIn(dir, digest);
    expect(fifo.status).toBe(1);
    expect(fifo.stderr).toContain("manifest.sha256 is not a regular file");
  });

  it("reports a manifest.json directory as invalid_document, not a raw EISDIR", () => {
    const { dir, digest } = fresh();
    rmSync(join(dir, "manifest.json"));
    mkdirSync(join(dir, "manifest.json"));
    writeFileSync(join(dir, "manifest.json", "x"), "x");
    expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|manifest\.json is not a regular file/);
  });

  it.skipIf(process.getuid?.() === 0)("wraps EACCES from an unreadable directory or file in an LmlError (verify and --check)", () => {
    const { dir, digest } = fresh();
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "f"), "x");
    chmodSync(join(dir, "locked"), 0);
    try {
      expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|cannot read .*locked: EACCES/);
      const c = cli(["generate", BUNDLE, "--bindings", BINDINGS, "--format", "json", "--out", dir, "--check"]);
      expect(c.status).toBe(1);
      expect(c.stderr).toContain("cannot read");
      expect(c.stderr).not.toContain("error: EACCES");
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
    }
    chmodSync(join(dir, "models.ts"), 0);
    try {
      expect(reason(() => verifyArtifacts({ root: dir, expectedSha256: digest }))).toMatch(/^invalid_document\|cannot read .*models\.ts: EACCES/);
    } finally {
      chmodSync(join(dir, "models.ts"), 0o644);
    }
  });
});

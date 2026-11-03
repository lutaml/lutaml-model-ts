import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalManifestJson, generateArtifacts, loadManifest, sha256Of, staleFiles } from "../../src/index.js";
import type { Bindings } from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const bundleBytes = readFileSync(join(HERE, "../cli/bundle.json"));
const bindings = JSON.parse(readFileSync(join(HERE, "../cli/bindings.json"), "utf8")) as Bindings;
const base = { bundleBytes, bundleFormat: "json", bindings } as const;

describe("generateArtifacts", () => {
  it("is byte-deterministic", () => {
    const a = generateArtifacts(base);
    const b = generateArtifacts(base);
    expect([...b.files]).toEqual([...a.files]);
    expect(b.manifestSha256).toBe(a.manifestSha256);
  });

  it("hashes each file's exact bytes, sorted, and the manifest digest covers the canonical manifest", () => {
    const set = generateArtifacts(base);
    const paths = set.manifest.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    for (const record of set.manifest.files) {
      expect(record.sha256).toBe(sha256Of(Buffer.from(set.files.get(record.path) as string, "utf8")));
    }
    expect(paths).not.toContain("manifest.json");
    expect(set.manifestSha256).toBe(sha256Of(set.manifestJson));
    expect(set.files.get("manifest.json")).toBe(`${set.manifestJson}\n`);
    expect(set.files.get("manifest.sha256")).toBe(`${set.manifestSha256}\n`);
    expect(set.manifest).toMatchObject({ manifest: 1, schema_version: 2, target: "ts", capabilities: ["json"], corpora: [] });
  });

  it("emits a manifest the package's own validator accepts", () => {
    const set = generateArtifacts(base);
    expect(loadManifest(Buffer.from(set.manifestJson), "json").target).toBe("ts");
  });

  it("changes the manifest digest when the output changes (yaml adds a codec family)", () => {
    const json = generateArtifacts(base);
    const both = generateArtifacts({ ...base, formats: ["yaml", "json"] });
    expect(both.manifest.capabilities).toEqual(["json", "yaml"]);
    expect(both.manifestSha256).not.toBe(json.manifestSha256);
    expect(both.manifest.lml_checksum).toBe(json.manifest.lml_checksum);
    expect([...both.files.keys()]).toContain("yaml/codecs.ts");
  });

  it("pins dependencies sorted, with binding modules", () => {
    const names = generateArtifacts(base).manifest.dependencies.map((d) => d.name);
    expect(names).toEqual(["lutaml-model-ts", "lutaml-model-ts/exact"]);
  });

  it("refuses a bundle whose exact types lack bindings", () => {
    expect(() => generateArtifacts({ ...base, bindings: { types: {} } })).toThrow(/missing_type_binding/);
  });
});

describe("canonicalManifestJson", () => {
  it("sorts keys recursively and rejects non-integers", () => {
    expect(canonicalManifestJson({ b: 1, a: [{ d: 1, c: "x" }] })).toBe('{"a":[{"c":"x","d":1}],"b":1}');
    expect(() => canonicalManifestJson({ a: 1.5 })).toThrow(/integers/);
  });
});

describe("staleFiles", () => {
  it("reports missing and changed files", () => {
    const files = new Map([["a.ts", "1"], ["b.ts", "2"], ["c.ts", "3"]]);
    const report = staleFiles(files, (p) => ({ "a.ts": "1", "b.ts": "x" })[p]);
    expect(report).toEqual({ missing: ["c.ts"], changed: ["b.ts"] });
  });
});

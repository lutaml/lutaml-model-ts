import { describe, expect, it } from "vitest";
import { canonicalManifestJson, generateArtifacts } from "../../src/artifacts/index.js";

// U+FFFD is EF BF BD in UTF-8, U+10000 is F0 90 80 80: bytes order U+FFFD first,
// UTF-16 code-unit order (U+10000 is D800 DC00) the other way round.
const LOW = "\u{10000}";
const HIGH = "�";

describe("L3: manifest ordering is by UTF-8 bytes (as the Ruby verifier)", () => {
  it("canonicalManifestJson sorts keys by bytes", () => {
    expect(canonicalManifestJson({ [LOW]: 1, [HIGH]: 2 })).toBe(`{"${HIGH}":2,"${LOW}":1}`);
  });

  it("dependency pins are ordered by module name bytes", () => {
    const bundle = { lml_bundle: 1, roots: ["A@default"], capabilities: [], value_types: {}, models: { "A@default": { lml: 2, model: "A", register: "default", attributes: [], mappings: {} } } };
    const set = generateArtifacts({
      bundleBytes: new TextEncoder().encode(JSON.stringify(bundle)),
      bundleFormat: "json",
      bindings: { types: { x: { module: `pkg-${LOW}`, export: "A" }, y: { module: `pkg-${HIGH}`, export: "B" } } },
      formats: ["json"],
    });
    const names = set.manifest.dependencies.map((d) => d.name);
    expect(names).toEqual(["lutaml-model-ts", `pkg-${HIGH}`, `pkg-${LOW}`]);
    expect(set.manifestJson.indexOf(`pkg-${HIGH}`)).toBeLessThan(set.manifestJson.indexOf(`pkg-${LOW}`));
  });
});

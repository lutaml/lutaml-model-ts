import { describe, expect, it } from "vitest";
import { ABSENT, ERROR_CODES, LmlError, checkDocumentVersion } from "../src/index.js";
import type { Bundle } from "../src/index.js";
import { run } from "../src/cli.js";

const bundle: Bundle = {
  lml_bundle: 1,
  roots: ["Example::Node@default"],
  models: {
    "Example::Node@default": {
      lml: 2,
      model: "Example::Node",
      register: "default",
      attributes: [
        {
          name: "children",
          type: { kind: "model", id: "Example::Node@default" },
          required: false,
          collection: { min: 0, max: null },
          default: { present: false },
          initialize_empty: false,
        },
      ],
      mappings: {
        xml: {
          root: { element: "node" },
          namespace: { mode: "inherit" },
          rules: [{ kind: "element", name: ["node"], to: "children" }],
        },
      },
    },
  },
  value_types: {},
  capabilities: ["json", "xml"],
};

describe("contract bootstrap", () => {
  it("accepts the supported bundle and document versions", () => {
    expect(checkDocumentVersion(bundle)).toBe("bundle");
    expect(checkDocumentVersion(bundle.models["Example::Node@default"])).toBe("document");
  });

  it("rejects unknown versions with unsupported_version", () => {
    expect(() => checkDocumentVersion({ lml: 3 })).toThrow(LmlError);
    try {
      checkDocumentVersion({ lml_bundle: 2 });
      expect.unreachable();
    } catch (e) {
      expect((e as LmlError).info).toMatchObject({ reason: "unsupported_version", location: "/lml_bundle" });
    }
  });

  it("rejects non-objects and unversioned values as invalid_document", () => {
    for (const bad of [null, [], "x", {}]) {
      expect(() => checkDocumentVersion(bad)).toThrow(/invalid_document/);
    }
  });

  it("lists every contract error code once", () => {
    expect(ERROR_CODES).toHaveLength(21);
    expect(new Set(ERROR_CODES).size).toBe(21);
  });

  it("keeps absent distinct from null", () => {
    expect(ABSENT).not.toBe(null);
    expect(typeof ABSENT).toBe("symbol");
  });

  it("CLI exposes only version and check-version", () => {
    expect(run([])).toBe(2);
    expect(run(["generate"])).toBe(2);
    expect(run(["check-version"])).toBe(2);
  });
});

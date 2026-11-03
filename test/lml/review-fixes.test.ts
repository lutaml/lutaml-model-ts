import { describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import { loadDocument, rubyFloat } from "../../src/lml/index.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function refused(run: () => unknown): LmlError {
  try {
    run();
  } catch (error) {
    if (error instanceof LmlError) return error;
    throw error;
  }
  throw new Error("expected an LmlError");
}

describe("L7: non-finite floats raise a named LmlError, not RangeError", () => {
  it("rubyFloat on NaN and Infinity", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(refused(() => rubyFloat(value)).info.reason).toBe("invalid_document");
    }
  });

  it("a v1 JSON document with 1e400 is refused at load", () => {
    const error = refused(() => loadDocument(enc('{"lml":1,"model":"A","attributes":[{"x":1e400}]}'), "json"));
    expect(error.info.reason).toBe("invalid_document");
    expect(error.info.detail).toMatch(/non-finite/);
  });

  it.each([".nan", ".inf", "-.inf"])("a v1 YAML document with %s is refused at load", (token) => {
    const error = refused(() => loadDocument(enc(`lml: 1\nmodel: A\nattributes:\n  - x: ${token}\n`), "yaml"));
    expect(error.info.reason).toBe("invalid_document");
  });

  it("control: a finite float still loads and keeps its Ruby spelling", () => {
    const loaded = loadDocument(enc('{"lml":1,"model":"A","attributes":[{"x":1.5e300}]}'), "json");
    expect(loaded.canonicalJson).toContain("1.5e+300");
  });
});

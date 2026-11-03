import { describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import type { Bundle } from "../../src/contracts.js";
import { attr, bundleOf, generated } from "../generator/support.js";

const node = (): Bundle =>
  bundleOf(
    [{ name: "kid", type: { kind: "model", id: "A@default" } }, attr("h", "hash", { default: { present: true, value: JSON.parse('{"__proto__":{"polluted":1},"k":2}') } })],
    {},
    { mappings: { json: { rules: [{ key: ["kid"], to: "kid" }, { key: ["h"], to: "h" }] } } },
  );

describe("L7: deep recursion is a named LmlError, not RangeError", () => {
  it("decoding a 100000-deep self-referential document", async () => {
    const { json } = await generated(node(), { json: true });
    const codec = json?.["CODECS"]["A@default"];
    const depth = 100_000;
    const text = '{"kid":'.repeat(depth) + "{}" + "}".repeat(depth);
    let caught: unknown;
    try {
      codec.parse(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as { name?: string }).name).toBe("LmlError");
    expect((caught as LmlError).info.reason).toBe("invalid_document");
    expect((caught as LmlError).info.detail).toMatch(/nested too deeply/);
  });

  it("control: moderate nesting still decodes", async () => {
    const { json } = await generated(node(), { json: true });
    const codec = json?.["CODECS"]["A@default"];
    const text = '{"kid":'.repeat(50) + "{}" + "}".repeat(50);
    expect(codec.parse(text).kid.kid).toBeDefined();
  });
});

describe("L8: a __proto__ hash default survives the codec as an own key", () => {
  it("encodes the own __proto__ key", async () => {
    const { models, json } = await generated(node(), { json: true });
    const a = new models["A"]();
    expect(Object.keys(a.h)).toContain("__proto__");
    expect(json?.["CODECS"]["A@default"].stringify(a)).toContain('"__proto__":{"polluted":1}');
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

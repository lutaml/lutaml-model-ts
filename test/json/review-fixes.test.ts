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

describe("round 3: strict JSON reader exactness, hash keys and order", () => {
  const hashCodec = async () => {
    const { json } = await generated(bundleOf([attr("h", "hash")], {}, { mappings: { json: { rules: [{ key: ["h"], to: "h" }] } } }), { json: true });
    return json?.["CODECS"]["A@default"];
  };
  it("refuses an integer beyond 2^53 whose spelling equals the rounded number's", async () => {
    const codec = await hashCodec();
    expect(() => codec.parse('{"h":{"n":123456789012345680000}}')).toThrow(/cannot be held exactly/);
    expect(() => codec.parse('{"h":{"n":12345678901234567890}}')).toThrow(/cannot be held exactly/);
    expect(codec.parse('{"h":{"n":9007199254740992}}').h.n).toBe(9007199254740992);
    expect(codec.parse('{"h":{"n":1152921504606846976}}').h.n).toBe(2 ** 60);
  });
  it("refuses a lone-surrogate hash key", async () => {
    const codec = await hashCodec();
    expect(() => codec.parse('{"h":{"\\ud800":1}}')).toThrow(/not valid Unicode/);
  });
  it("refuses integer-like keys that JS would reorder, keeps ascending ones", async () => {
    const codec = await hashCodec();
    expect(() => codec.parse('{"h":{"b":1,"2":2,"a":3,"1":4}}')).toThrow(/key order cannot be preserved/);
    expect(() => codec.parse('{"h":{"2":1,"1":2}}')).toThrow(/key order cannot be preserved/);
    expect(codec.stringify(codec.parse('{"h":{"1":4,"2":2,"b":1,"a":3}}'))).toBe('{"h":{"1":4,"2":2,"b":1,"a":3}}');
    expect(codec.stringify(codec.parse('{"h":{"01":1,"b":2,"-1":3}}'))).toBe('{"h":{"01":1,"b":2,"-1":3}}');
  });
});

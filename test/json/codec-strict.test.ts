import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalFloat, floatWire } from "../../src/lml/float.js";
import { codecRuntimeSource } from "../../src/codecs/runtime-source.js";
import { xmlRuntimeSource } from "../../src/xml/runtime-source.js";
import { attr, bundleOf, codeOf, detailOf, generated } from "../generator/support.js";

const bundle = () =>
  bundleOf([attr("id", "string"), attr("h", "hash"), attr("f", "float")], {}, {
    mappings: { json: { rules: [{ key: ["id"], to: "id" }, { key: ["h"], to: "h" }, { key: ["f"], to: "f" }] } },
  });

describe("the generated JSON codec reads strictly (M2)", () => {
  it("refuses a repeated key", async () => {
    const { json } = await generated(bundle(), { json: true });
    const codec = json?.["CODECS"]["A@default"];
    expect(codeOf(() => codec.parse('{"id":"a","id":"b"}'))).toBe("invalid_document");
    expect(detailOf(() => codec.parse('{"id":"a","h":{"k":1,"k":2}}'))).toMatch(/duplicate key "k"/);
  });

  it("refuses numbers a JS number cannot hold exactly", async () => {
    const { json } = await generated(bundle(), { json: true });
    const codec = json?.["CODECS"]["A@default"];
    for (const n of ["12345678901234567890", "1.0", "-0", "1e2", "1E5"]) {
      expect(detailOf(() => codec.parse(`{"id":"a","h":{"n":${n}}}`)), n).toMatch(/cannot be held exactly/);
    }
    expect(codec.parse('{"id":"a","h":{"n":1.5,"m":-7,"z":0}}').h).toEqual({ n: 1.5, m: -7, z: 0 });
  });

  it("keeps a __proto__ key as an own property and rejects trailing text and bad syntax", async () => {
    const { json } = await generated(bundle(), { json: true });
    const codec = json?.["CODECS"]["A@default"];
    const v = codec.parse('{"id":"a","h":{"__proto__":{"p":1}}}');
    expect(Object.keys(v.h)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["p"]).toBeUndefined();
    for (const bad of ['{"id":"a"} x', '{"id":"a",}', "{'id':'a'}", '{"id":"a\\q"}', ""]) {
      expect(codeOf(() => codec.parse(bad)), bad).toBe("invalid_document");
    }
  });
});

describe("one float source (float.ts) is embedded in every runtime", () => {
  const embedded = (src: string): { floatWire: (n: number) => string; canonicalFloat: (v: unknown) => boolean } => {
    const m = /const FLOAT_WIRE = [^\n]*\nconst floatWire = \(([\s\S]*?)\) as [^\n]*\nconst canonicalFloat = \(([\s\S]*?)\) as [^\n]*\n/.exec(src);
    if (m === null) throw new Error("float block not found");
    const make = new Function(`${(/const FLOAT_WIRE = [^\n]*/.exec(src) as RegExpExecArray)[0]}\nconst floatWire = (${m[1]});\nconst canonicalFloat = (${m[2]});\nreturn { floatWire, canonicalFloat };`);
    return make() as never;
  };
  it("the emitted function text is float.ts's own", () => {
    for (const src of [codecRuntimeSource("./c.js", "json"), xmlRuntimeSource("./c.js")]) {
      expect(src).toContain(floatWire.toString());
      expect(src).toContain(canonicalFloat.toString());
    }
  });
  it("behaves identically on the Ruby sweep vectors", () => {
    const rows = JSON.parse(readFileSync(new URL("../lml/fixtures/float_sweep_vectors.json", import.meta.url), "utf8")) as [string, string, string][];
    for (const src of [codecRuntimeSource("./c.js", "json"), xmlRuntimeSource("./c.js")]) {
      const e = embedded(src);
      for (const [hex, toS] of rows) {
        const n = Buffer.from(hex, "hex").readDoubleBE(0);
        expect(e.floatWire(n)).toBe(floatWire(n));
        expect(e.canonicalFloat(e.floatWire(n))).toBe(true);
        expect(e.floatWire(n).includes("e"), toS).toBe(toS.includes("e"));
      }
      expect(e.floatWire(1151450203773890.8)).toBe("1151450203773890.8");
    }
  });
});

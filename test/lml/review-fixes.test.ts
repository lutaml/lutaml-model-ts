import { describe, expect, it } from "vitest";
import { LmlError } from "../../src/contracts.js";
import { parseRaw, RawFloat } from "../../src/lml/raw.js";
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

describe("YAML 1.1 versus 1.2 ambiguous plain scalars are refused", () => {
  const read = (text: string) => parseRaw(new TextEncoder().encode(text), "yaml");
  for (const v of ["yes", "No", "on", "off", "010", "0o10", "0b11", "1_000", "1:30", "1e3", "2020-01-01", "1,000", "tRue", "fAlsE", "0x_1", "0x1_F", "-0x1", ":sym"]) {
    it(`refuses plain ${v}`, () => {
      expect(() => read(`a: ${v}`)).toThrow(/read differently by YAML 1.1/);
    });
  }
  it("refuses a merge key, which Psych expands", () => {
    expect(() => read("a: {<<: {k: 1}}")).toThrow(/read differently by YAML 1.1/);
  });
  it("reads y/n and the canonical booleans (Psych reads them the same way)", () => {
    const m = read("y: y\nn: N\nt: true\nu: True\nv: FALSE\nq: ':sym'") as ReadonlyMap<string, unknown>;
    expect([m.get("y"), m.get("n"), m.get("t"), m.get("u"), m.get("v"), m.get("q")]).toEqual(["y", "N", true, true, false, ":sym"]);
  });
  it("reads quoted and unambiguous scalars", () => {
    const m = read("a: 'yes'\nb: 10\nc: text\nd: 1.5\ne: 0\nf: 0x1F") as ReadonlyMap<string, unknown>;
    expect(m.get("a")).toBe("yes");
    expect(m.get("b")).toBe(10);
    expect(m.get("d")).toBeDefined();
  });
});

describe("round 3 N1/N7: YAML scalars Psych types differently", () => {
  const read = (text: string) => parseRaw(new TextEncoder().encode(text), "yaml") as ReadonlyMap<string, unknown>;
  // Psych safe_load: nUll nil; .iNf Infinity; .nAn NaN; 1,2.5 12.5; 1,000.5 1000.5; 0,. 0.0
  for (const v of ["nUll", "nULL", "NuLL", ".iNf", ".INF", "-.iNf", "+.Inf", ".nAn", ".NAN", "1,2.5", "1,000.5", "0,.", "1,000.5e+3", "000_,", "0b1,", "1_0,0", "08", "010", "1e3", "1_000"]) {
    it(`refuses plain ${v}`, () => {
      expect(() => read(`k: ${v}`)).toThrow(/read differently by YAML 1.1/);
      expect(() => read(`${v}: x`)).toThrow(/read differently by YAML 1.1/);
    });
  }
  it("still reads quoted spellings as strings", () => {
    expect(read("k: 'nUll'\nj: \".iNf\"").get("k")).toBe("nUll");
  });
  // Psych and YAML 1.2 agree on these: reading them is not an over-refusal any more.
  it.each([["00", 0], ["07", 7], ["-007", -7], ["1.5E+3", 1500], ["6.02E+23", 6.02e23], ["0.1e-2", 0.001]])("reads %s as the number Psych reads", (text, value) => {
    const got = read(`k: ${text}`).get("k");
    expect(got instanceof RawFloat ? got.value : Number(got)).toBe(value);
  });
  it.each(["10_", "1,", "1__", "5,,"])("reads %s as the string Psych reads", (text) => {
    expect(read(`k: ${text}`).get("k")).toBe(text);
  });
});

describe("round 4: lone surrogates in LML documents", () => {
  const raw = (text: string, f: "json" | "yaml") => parseRaw(new TextEncoder().encode(text), f);
  it.each([['{"k":"\\ud800"}', "json"], ['{"\\udc00":1}', "json"], ['k: "\\ud800"\n', "yaml"], ['"\\udc00": 1\n', "yaml"]] as const)("refuses %s (%s)", (text, f) => {
    expect(() => raw(text, f)).toThrow(/not valid Unicode|lone surrogate/);
  });
  it("accepts a valid surrogate pair", () => {
    expect((raw('{"k":"\\ud83d\\ude00"}', "json") as ReadonlyMap<string, unknown>).get("k")).toBe("\u{1F600}");
  });
});

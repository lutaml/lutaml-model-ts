import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// moxml-ts is a git dependency (lutaml/moxml-ts#9). When it is absent the probe
// exits 2 with a capability error and these cases are reported as skipped,
// never as passed.
const run = spawnSync(process.execPath, ["scripts/probe-moxml.mjs", "--json"], { encoding: "utf8" });
const available = run.status !== 2;

interface Case { id: string; face: string; status: string; match: boolean; observed: unknown; expected: unknown }

describe("moxml-ts capability probe", () => {
  it("reports a precise capability error when moxml-ts is not installed", () => {
    if (available) return;
    expect(run.stderr).toMatch(/^MOXML_TS_UNAVAILABLE: moxml-ts is not installed/);
  });

  describe.skipIf(!available)("pinned facade", () => {
    const cases: Case[] = available ? JSON.parse(run.stdout) : [];

    it("exits 0: every recorded observation still holds", () => {
      expect(run.status, run.stderr).toBe(0);
    });

    it("covers every face the codecs need", () => {
      const faces = new Set(cases.map((c) => c.face));
      for (const f of ["pin", "parser", "namespace", "attribute", "mixed-content", "builder", "serialization", "parser-policy"]) {
        expect(faces.has(f), f).toBe(true);
      }
      expect(cases.length).toBe(31);
    });

    it("no drift between the recorded and observed behaviour", () => {
      expect(cases.filter((c) => !c.match).map((c) => c.id)).toEqual([]);
    });

    it("records the missing and unsafe faces precisely", () => {
      const ids = (s: string) => cases.filter((c) => c.status === s).map((c) => c.id);
      expect(ids("absent")).toEqual(["BLD-04", "SER-03", "POL-09"]);
      expect(ids("unsafe")).toEqual(["ATTR-04", "POL-06", "POL-08"]);
    });
  });
});

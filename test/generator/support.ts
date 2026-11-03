import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll } from "vitest";
import { LmlError } from "../../src/contracts.js";
import type { Bindings, Bundle, ErrorCode, ModelDocument } from "../../src/contracts.js";
import { createKeyValueEmitter } from "../../src/codecs/index.js";
import { generateModelsWith } from "../../src/generator/index.js";

const REPO = resolve(import.meta.dirname, "../..");
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loaded = Record<string, any>;

/** A one-model bundle `A@default` with the given attributes and value types. */
export function bundleOf(
  attributes: readonly unknown[],
  valueTypes: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Bundle {
  return {
    lml_bundle: 1,
    roots: ["A@default"],
    capabilities: [],
    value_types: valueTypes,
    models: {
      "A@default": { lml: 2, model: "A", register: "default", attributes, ...extra },
    },
  } as unknown as Bundle;
}

export function attr(name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type: { kind: "builtin", name: type }, ...extra };
}

/** Generates models (+ json codecs) into a temp dir and imports them. */
export async function generated(
  bundle: Bundle,
  opts: { bindings?: Bindings; json?: boolean } = {},
): Promise<{ dir: string; models: Loaded; json: Loaded | null }> {
  const dir = mkdtempSync(join(tmpdir(), "lml-review-"));
  created.push(dir);
  const contractsModule = "./contracts-shim.js";
  const emitters = opts.json === true ? [createKeyValueEmitter("json", { contractsModule })] : [];
  const files = generateModelsWith(bundle, opts.bindings ?? { types: {} }, emitters, { contractsModule });
  for (const [path, text] of files) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  copyFileSync(join(REPO, "src/contracts.ts"), join(dir, "contracts-shim.ts"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  const models = (await import(pathToFileURL(join(dir, "index.ts")).href)) as Loaded;
  const json = opts.json === true ? ((await import(pathToFileURL(join(dir, "json/index.ts")).href)) as Loaded) : null;
  return { dir, models, json };
}

/** The named error code a generation/codec call raises; undefined when it succeeds. */
export function codeOf(run: () => unknown): ErrorCode | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LmlError) return error.info.reason;
    if ((error as { name?: string }).name === "LmlError") return (error as LmlError).info.reason;
    throw error;
  }
  return undefined;
}

export function detailOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as LmlError).info?.detail ?? String(error);
  }
  return "";
}

export type { ModelDocument };

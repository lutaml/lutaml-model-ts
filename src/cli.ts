#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LmlError } from "./contracts.js";
import type { Bindings, SchemaFormat } from "./contracts.js";
import { generateArtifacts, staleFiles } from "./artifacts/index.js";
import type { KeyValueFormat } from "./codecs/index.js";
import { checkDocumentVersion } from "./version.js";

const USAGE = `usage: lutaml-model-ts <command>

commands:
  version                     print supported contract versions
  check-version <file.json>   verify a document/bundle declares a supported version
  generate <bundle> --out <dir> [options]
                              write TypeScript models, codecs and manifest.json
      --format json|yaml      key-value codec family (repeatable; default json)
      --bindings <file.json>  trusted value-type bindings ({"types": {...}})
      --check                 write nothing; exit 1 if <dir> is missing or stale
`;

interface GenerateArgs {
  readonly bundle: string;
  readonly out: string;
  readonly formats: readonly KeyValueFormat[];
  readonly bindings: string | undefined;
  readonly check: boolean;
}

class UsageError extends Error {}

function parseGenerate(args: readonly string[]): GenerateArgs {
  let bundle: string | undefined;
  let out: string | undefined;
  let bindings: string | undefined;
  let check = false;
  const formats: KeyValueFormat[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const value = (): string => {
      i += 1;
      const next = args[i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--out") out = value();
    else if (arg === "--bindings") bindings = value();
    else if (arg === "--check") check = true;
    else if (arg === "--format") {
      const format = value();
      if (format !== "json" && format !== "yaml") throw new UsageError(`unknown format ${format}`);
      formats.push(format);
    } else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    else if (bundle === undefined) bundle = arg;
    else throw new UsageError(`unexpected argument ${arg}`);
  }
  if (bundle === undefined) throw new UsageError("missing <bundle>");
  if (out === undefined) throw new UsageError("missing --out");
  return { bundle, out, formats: formats.length === 0 ? ["json"] : formats, bindings, check };
}

function schemaFormat(path: string): SchemaFormat {
  return /\.ya?ml$/i.test(path) ? "yaml" : "json";
}

function readOptional(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function generate(args: readonly string[]): number {
  const parsed = parseGenerate(args);
  const bindings: Bindings =
    parsed.bindings === undefined ? { types: {} } : (JSON.parse(readFileSync(parsed.bindings, "utf8")) as Bindings);
  const result = generateArtifacts({
    bundleBytes: readFileSync(parsed.bundle),
    bundleFormat: schemaFormat(parsed.bundle),
    bindings,
    formats: parsed.formats,
  });
  const root = resolve(parsed.out);
  if (parsed.check) {
    const report = staleFiles(result.files, (path) => readOptional(root, path));
    if (report.missing.length === 0 && report.changed.length === 0) {
      process.stdout.write(`up to date: ${result.manifestSha256}\n`);
      return 0;
    }
    for (const path of report.missing) process.stderr.write(`missing: ${path}\n`);
    for (const path of report.changed) process.stderr.write(`stale: ${path}\n`);
    return 1;
  }
  for (const [path, text] of result.files) {
    const target = join(root, path);
    // Paths come from the generator (already validated relative, no traversal); belt and braces.
    if (!target.startsWith(root + sep)) throw new Error(`refusing to write outside ${root}: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  process.stdout.write(`${result.manifestSha256}\n`);
  return 0;
}

export function run(argv: readonly string[]): number {
  const [command, file] = argv;
  try {
    switch (command) {
      case "version":
        process.stdout.write("lml document: 2\nlml bundle: 1\nmanifest: 1\n");
        return 0;
      case "check-version": {
        if (file === undefined) {
          process.stderr.write(USAGE);
          return 2;
        }
        const kind = checkDocumentVersion(JSON.parse(readFileSync(file, "utf8")));
        process.stdout.write(`ok: ${kind}\n`);
        return 0;
      }
      case "generate":
        return generate(argv.slice(1));
      default:
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof LmlError) {
      const info = error.info;
      process.stderr.write(`${error.message}${info.location ? ` at ${info.location}` : ""}\n`);
      return 1;
    }
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = run(process.argv.slice(2));
}

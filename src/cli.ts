#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { LmlError } from "./contracts.js";
import { checkDocumentVersion } from "./version.js";

const USAGE = `usage: lutaml-model-ts <command>

commands:
  version                     print supported contract versions
  check-version <file.json>   verify a document/bundle declares a supported version
`;

export function run(argv: readonly string[]): number {
  const [command, file] = argv;
  switch (command) {
    case "version":
      process.stdout.write("lml document: 2\nlml bundle: 1\nmanifest: 1\n");
      return 0;
    case "check-version": {
      if (file === undefined) {
        process.stderr.write(USAGE);
        return 2;
      }
      try {
        const kind = checkDocumentVersion(JSON.parse(readFileSync(file, "utf8")));
        process.stdout.write(`ok: ${kind}\n`);
        return 0;
      } catch (error) {
        if (error instanceof LmlError) {
          process.stderr.write(`${error.message}${error.info.location ? ` at ${error.info.location}` : ""}\n`);
          return 1;
        }
        process.stderr.write(`error: ${(error as Error).message}\n`);
        return 1;
      }
    }
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}

import * as YAML from "yaml";
import type { SchemaFormat } from "../contracts.js";
import { fail } from "./errors.js";

/** A non-integer number from the source (Ruby Float); legal only in v1 documents. */
export class RawFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
    Object.freeze(this);
  }
}

/**
 * Parsed but unvalidated tree. Objects are insertion-ordered maps so that the
 * v1 canonical form (which keeps source order) survives JS integer-key
 * reordering. Integers are `number` when safe, `bigint` otherwise.
 */
export type Raw =
  | null
  | boolean
  | number
  | bigint
  | string
  | RawFloat
  | readonly Raw[]
  | RawMap;
export type RawMap = ReadonlyMap<unknown, Raw>;

/** A float that overflows to Infinity (1e400) or is NaN/Inf (YAML) has no portable form. */
function finiteFloat(value: number): RawFloat {
  if (!Number.isFinite(value)) fail("invalid_document", "non-finite float is not accepted", "");
  return new RawFloat(value);
}

function intValue(big: bigint): number | bigint {
  const n = Number(big);
  return Number.isSafeInteger(n) ? n : big;
}

function decode(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("invalid_document", "byte order mark is not accepted", "");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("invalid_document", "input is not valid UTF-8", "");
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};
const MAX_PARSE_DEPTH = 512;

/** Stricter JSON rules the Ruby importer applies to bundle text only. */
export interface ParseOptions {
  /** Containers nest at most this many levels (Ruby `JSON.parse(max_nesting:)`). */
  readonly maxNesting?: number;
  /** An object repeating a key is refused (Ruby `Importer.reject_duplicate_keys!`). */
  readonly rejectDuplicateKeys?: boolean;
}

/**
 * Strict RFC 8259 parser into insertion-ordered maps. JSON.parse cannot be
 * used: it reorders integer-like keys and hides 1 versus 1.0.
 */
class JsonParser {
  private pos = 0;
  constructor(private readonly src: string, private readonly options: ParseOptions = {}) {}

  parse(): Raw {
    const value = this.value(0);
    this.space();
    if (this.pos !== this.src.length) this.error("unexpected trailing characters");
    return value;
  }

  private error(message: string): never {
    return fail("invalid_document", `json: ${message} at offset ${this.pos}`, "");
  }

  private space(): void {
    while (this.pos < this.src.length && " \t\n\r".includes(this.src[this.pos] as string)) this.pos++;
  }

  private value(depth: number): Raw {
    if (depth > MAX_PARSE_DEPTH) this.error("nesting too deep");
    this.space();
    const ch = this.src[this.pos];
    // Root is level 1; `max_nesting: 100` refuses the 101st container level.
    const limit = this.options.maxNesting;
    if ((ch === "{" || ch === "[") && limit !== undefined && depth >= limit) {
      this.error(`nesting of ${depth + 1} is too deep`);
    }
    if (ch === "{") return this.object(depth);
    if (ch === "[") return this.array(depth);
    if (ch === '"') return this.string();
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.src.startsWith(word, this.pos)) {
        this.pos += word.length;
        return value;
      }
    }
    return this.number();
  }

  private number(): Raw {
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.src);
    if (m === null) this.error("unexpected character");
    this.pos += m[0].length;
    if (m[1] === undefined && m[2] === undefined) return intValue(BigInt(m[0]));
    return finiteFloat(Number(m[0]));
  }

  private string(): string {
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.src[this.pos++];
      if (ch === undefined) this.error("unterminated string");
      if (ch === '"') return out;
      if (ch < " ") this.error("control character in string");
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.src[this.pos++];
      if (esc === "u") {
        const hex = this.src.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error("bad unicode escape");
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 4;
      } else if (esc !== undefined && Object.hasOwn(ESCAPES, esc)) {
        out += ESCAPES[esc];
      } else {
        this.error("bad escape");
      }
    }
  }

  private array(depth: number): Raw {
    this.pos++;
    const out: Raw[] = [];
    this.space();
    if (this.src[this.pos] === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      this.space();
      const ch = this.src[this.pos++];
      if (ch === "]") return out;
      if (ch !== ",") this.error("expected , or ]");
    }
  }

  private object(depth: number): Raw {
    this.pos++;
    const out = new Map<unknown, Raw>();
    this.space();
    if (this.src[this.pos] === "}") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.space();
      if (this.src[this.pos] !== '"') this.error("expected a string key");
      const key = this.string();
      this.space();
      if (this.src[this.pos++] !== ":") this.error("expected :");
      // Without the option a duplicate key keeps the last value in its first position (legacy v1, as Ruby).
      if (this.options.rejectDuplicateKeys && out.has(key)) {
        fail("invalid_document", `duplicate key ${JSON.stringify(key)}`, "");
      }
      out.set(key, this.value(depth + 1));
      this.space();
      const ch = this.src[this.pos++];
      if (ch === "}") return out;
      if (ch !== ",") this.error("expected , or }");
    }
  }
}

function jsonToRaw(text: string, options: ParseOptions): Raw {
  return new JsonParser(text, options).parse();
}

/**
 * Plain scalars that YAML 1.2 (this reader) and Ruby Psych (YAML 1.1) resolve
 * differently: 1.1 booleans (yes/no/on/off/y/n), underscored numbers, leading-zero
 * octal, 0o octal, 0b binary, sexagesimal, exponent floats, timestamps. Refused by
 * name rather than read one way here and another in Ruby; quote the value to keep a string.
 */
const YAML_AMBIGUOUS = [
  /^(?:yes|no|on|off)$/i,
  // Psych matches true/false case-insensitively; YAML 1.2 only true/True/TRUE (and false likewise).
  /^(?:true|false)$/i,
  // Psych reads 0x with _ or , separators and a signed 0x as an integer; YAML 1.2 as a string.
  /^[-+]?0x[0-9a-fA-F_,]*[_,][0-9a-fA-F_,]*$/,
  /^[-+]0x[0-9a-fA-F]+$/,
  // Psych reads :name as a Symbol (disallowed by safe_load); a merge key <<.
  /^:\S/,
  /^<<$/,
  /^[-+]?0[0-9_]+$/,
  /^[-+]?0[ob][0-9a-fA-F_]+$/,
  /^[-+]?[0-9][0-9_]*_[0-9_]*(?:\.[0-9_]*)?$/,
  /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/,
  /^[-+]?(?:[0-9][0-9_]*)?\.?[0-9]+[eE][-+]?[0-9]+$/,
  /^[-+]?[0-9]+\.[0-9]*[eE][-+]?[0-9]+$/,
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:$|[Tt\s])/,
  /^[-+]?[0-9][0-9,]*,[0-9,]*$/,
];

const YAML_CANONICAL_BOOLEAN = /^(?:true|True|TRUE|false|False|FALSE)$/;

function yamlToRaw(text: string): Raw {
  const doc = YAML.parseDocument(text, {
    schema: "core",
    version: "1.2",
    merge: false,
    uniqueKeys: true,
    intAsBigInt: true,
    prettyErrors: false,
  });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) fail("invalid_document", `YAML: ${problem.code}`, "");
  if (doc.contents === null) fail("invalid_document", "empty YAML document", "");
  YAML.visit(doc, {
    Alias: () => fail("invalid_document", "YAML aliases are not accepted", ""),
    Node: (_key, node) => {
      if (node.anchor !== undefined) fail("invalid_document", "YAML anchors are not accepted", "");
      if (YAML.isScalar(node) && node.type === "PLAIN" && typeof node.source === "string" && !YAML_CANONICAL_BOOLEAN.test(node.source) && YAML_AMBIGUOUS.some((re) => re.test(node.source as string))) {
        fail("invalid_document", `YAML scalar ${node.source} is read differently by YAML 1.1 (Ruby); quote it`, "");
      }
      if (node.tag !== undefined) fail("invalid_document", `YAML tag ${node.tag} is not accepted`, "");
    },
  });
  return nodeToRaw(doc.contents);
}

function nodeToRaw(node: unknown): Raw {
  if (YAML.isMap(node)) {
    const out = new Map<unknown, Raw>();
    for (const pair of node.items) {
      const key = YAML.isScalar(pair.key) ? scalarToRaw(pair.key.value) : fail("invalid_document", "non-scalar key", "");
      out.set(key, nodeToRaw(pair.value));
    }
    return out;
  }
  if (YAML.isSeq(node)) return node.items.map(nodeToRaw);
  if (YAML.isScalar(node)) return scalarToRaw(node.value);
  return fail("invalid_document", "unsupported YAML node", "");
}

function scalarToRaw(value: unknown): Raw {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return intValue(value);
  if (typeof value === "number") return finiteFloat(value);
  return fail("invalid_document", `unsupported YAML value ${typeof value}`, "");
}

/** Parses bytes into the unvalidated tree; never evaluates anything. */
export function parseRaw(bytes: Uint8Array, format: SchemaFormat, options: ParseOptions = {}): Raw {
  const text = decode(bytes);
  try {
    if (format === "json") return jsonToRaw(text, options);
    if (format === "yaml") return yamlToRaw(text);
  } catch (error) {
    if (error instanceof Error && error.name === "LmlError") throw error;
    const detail = error instanceof RangeError ? "nesting too deep" : error instanceof Error ? error.message : "parse error";
    return fail("invalid_document", `${format}: ${detail}`, "");
  }
  return fail("unsupported_format", `schema format ${String(format)}`, "");
}

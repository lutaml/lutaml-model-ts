// Shared comparison helpers for scripts/mml/run.mjs and test/mml (no I/O).
import { parse as moxmlParse } from "moxml-ts";

// ---- canonical XML tree: [[ns,local],[[ [ns,local],value ]...sorted],[children: tree|string]]
export function treeOf(node) {
  const attrs = (node.attributes() ?? [])
    .filter((a) => a.localName !== "xmlns" && !(a.qualifiedName ?? "").startsWith("xmlns"))
    .map((a) => [[a.namespaceUri ?? "", a.localName], a.value])
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  const kids = [];
  for (const child of node.children()) {
    const kind = child.kind();
    if (kind === 1) kids.push(treeOf(child));
    else if (kind === 2 || kind === 4) {
      const text = child.text() ?? "";
      typeof kids.at(-1) === "string" ? (kids[kids.length - 1] += text) : kids.push(text);
    } // comments and processing instructions are not part of the tree (counted separately)
  }
  return [[node.namespaceUri() ?? "", node.localName() ?? ""], attrs, kids];
}
export async function canonicalTree(xml) {
  const doc = await moxmlParse(xml.replace(/<!DOCTYPE[^>]*>/i, ""));
  return treeOf(doc.root());
}
// Ruby always pretty-prints (to_xml(pretty: false) is ignored by mml 2.4.7), so trees are compared
// with whitespace-only text dropped wherever an element has element children. Text is never trimmed.
export function stripWs(tree) {
  if (typeof tree === "string") return tree;
  const [name, attrs, kids] = tree;
  const hasElement = kids.some((k) => typeof k !== "string");
  const out = [];
  for (const k of kids) {
    if (typeof k === "string") { if (!(hasElement && k.trim() === "")) out.push(k); } else out.push(stripWs(k));
  }
  return [name, attrs, out];
}

// ---- neutral model dump shared with scripts/mml/ruby_oracle.rb
export function dump(value) {
  if (value === null || value === undefined || typeof value === "symbol") return null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(dump);
  if (typeof value === "object" && Array.isArray(value.constructor?.memberNames)) {
    const out = {};
    for (const name of value.constructor.memberNames) out[name] = dump(value[name]);
    out.__lml_model = value.constructor.modelId;
    return out;
  }
  return value;
}
export const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
// Collapses the three spellings of "no value": null, [] and {"state":"absent"}.
export function emptyNormal(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length === 0 ? null : v.map(emptyNormal);
  if (typeof v === "object") {
    if (Object.keys(v).length === 1 && v.state === "absent") return null;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptyNormal(x)]));
  }
  return v;
}
export function firstDiff(a, b, path = "") {
  if (stable(a) === stable(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], `${path}/${k}`);
      if (d) return d;
    }
  }
  return `${path}: ruby=${stable(a)?.slice(0, 80)} ts=${stable(b)?.slice(0, 80)}`;
}

export function refusalClass(info) {
  const detail = info?.detail ?? "";
  if (/DOCTYPE/i.test(detail)) return "refused: doctype";
  if (/parse failed/.test(detail)) return "refused: malformed XML (parser: e.g. several root elements; libxml2 recovers)";
  if (/expected root element .* found/.test(detail)) return `refused: root/namespace (${info.reason})`;
  return `refused: ${info?.reason ?? "?"}: ${detail.replace(/[0-9]+/g, "#").replace(/"[^"]*"/g, '"…"').slice(0, 90)}`;
}
export function rubyClass(row) {
  return `${row.error}: ${row.message.replace(/Mml::V\d::\w+/g, "Mml::V#::<Model>").replace(/[0-9]+/g, "#").replace(/"[^"]*"/g, '"…"').slice(0, 90)}`;
}


/** Whitespace runs inside text and attribute values collapsed to one space (not trimmed). */
export function squeezeWs(tree) {
  if (typeof tree === "string") return tree.replace(/\s+/g, " ");
  const [name, attrs, kids] = tree;
  return [name, attrs.map(([n, v]) => [n, v.replace(/\s+/g, " ")]), kids.map(squeezeWs)];
}

/** Names the mismatch class from the first data/tree differences (see docs/mml-pilot.md). */
export function causeOf(dData, dTree, squeezed) {
  const d = `${dData ?? ""} ${dTree ?? ""}`;
  if (/other_attributes/.test(d)) return "catch-all attributes: Ruby map_all_attributes (other_attributes) has no rule in the LML graph; TS drops them";
  if (/value: ruby=\[/.test(d)) return "text split around a comment: Ruby keeps two values, TS joins them";
  if (squeezed) return "whitespace normalisation inside a value (Ruby/libxml2 keeps literal LF in attribute values; TS follows the XML spec)";
  if (/__lml_content: ruby=\[\{"attribute":"[^"]*","index":\d+,"kind":"text"\}\] ts=null/.test(d)) return "empty or whitespace-only text node: Ruby records an ordered-content text token, TS records none";
  if (/ruby=undefined ts="(\s|\\n)*"/.test(d)) return "whitespace-only text: TS keeps it, Ruby drops it";
  if (/&[A-Za-z]/.test(d)) return "undefined entity reference (input is not well-formed XML): parsers recover differently";
  if (/^\/lang:/.test(d)) return "xml:lang read by Ruby into lang, not by TS";
  if (/__lml_content\/\d+: ruby=/.test(d)) return "ordered-content token list differs (mmultiscripts/mprescripts)";
  return `other: ${(dData ?? dTree ?? "").replace(/\/\d+/g, "/N").slice(0, 70)}`;
}

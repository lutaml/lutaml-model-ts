#!/usr/bin/env node
// Executable capability probe for the public moxml-ts XML facade (card 07a).
// Uses only what `import "moxml-ts"` exports. Every case states what the
// codecs need (face), what the pinned facade actually does (observed), and a
// status: supported | partial | absent | unsafe. A case whose observation
// differs from the recorded EXPECTATION is a drift failure (exit 1).
// Exit codes: 0 all observations match; 1 drift/probe error; 2 moxml-ts unavailable.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PIN = {
  package: "moxml-ts",
  version: "0.1.0",
  // lutaml/moxml-ts#9 (draft) head; the repo's package-lock.json must resolve to it.
  commit: "9a70a2ba9119c7be8545c32e0e7385e6a8100875",
  // First 16 hex chars of the sha256 of the vendored wasm bundles (no .pin files ship in the install).
  leptrisWasm: "b85b0256a3885448",
  moxmlWasm: "87bed5fe83f5d7e8",
};
const UP = "lutaml/moxml-ts (src/document.ts)";
const NS = "lutaml/leptris-rs#22 (namespace/attribute/capability follow-through)";

const KIND = { element: 1, text: 2, comment: 3, cdata: 4, pi: 5 };

async function load() {
  try {
    return await import("moxml-ts");
  } catch (cause) {
    const e = new Error(
      "MOXML_TS_UNAVAILABLE: moxml-ts is not installed (not on npm; run `npm ci` (moxml-ts is a git dependency at lutaml/moxml-ts#9 " +
        PIN.commit.slice(0, 7) + "; see docs/xml-capabilities.md): " +
        String(cause.message).split("\n")[0],
    );
    e.code = "MOXML_TS_UNAVAILABLE";
    throw e;
  }
}

function installedPins() {
  // exports hides package.json; the entry is <root>/dist/index.js.
  const root = fileURLToPath(new URL("../", import.meta.resolve("moxml-ts")));
  const read = (p) => readFileSync(root + p, "utf8").trim();
  const digest = (p) => createHash("sha256").update(readFileSync(root + p)).digest("hex").slice(0, 16);
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const resolved = lock.packages?.["node_modules/moxml-ts"]?.resolved ?? "";
  return {
    version: JSON.parse(read("package.json")).version,
    commit: resolved.split("#")[1] ?? "",
    leptrisWasm: digest("vendor/leptris-wasm/leptris_bg.wasm"),
    moxmlWasm: digest("vendor/moxml-wasm/moxml_bg.wasm"),
  };
}

const capture = async (f) => {
  try {
    return { ok: await f() };
  } catch (e) {
    return { threw: String(e?.message ?? e) };
  }
};

export async function runProbe() {
  const m = await load();
  const cases = [];
  const add = (id, face, status, expected, observed, note, upstream = UP) =>
    cases.push({ id, face, status, expected, observed, note, upstream, match: JSON.stringify(expected) === JSON.stringify(observed) });

  const pins = installedPins();
  add("PIN-01", "pin", "supported",
    { version: PIN.version, commit: PIN.commit, leptrisWasm: PIN.leptrisWasm, moxmlWasm: PIN.moxmlWasm },
    pins, "installed moxml-ts matches the pin recorded in this script", UP);

  // ---- engine init: first parse needs no explicit init under Node.
  const first = await capture(async () => (await m.parse("<a/>")).rootName());
  add("INIT-01", "parser", "supported", { ok: "a" }, first, "lazy wasm init: no explicit await initEngine() needed under Node");

  // ---- namespace URI / prefix
  const ns = await m.parse(
    '<r xmlns="urn:d" xmlns:p="urn:p" k="v" p:z="1"><p:b/><c xmlns=""/></r>',
  );
  const nodeNames = ns.root().children().map((c) => c.name());
  add("NS-01", "namespace", "supported",
    { rootUri: "urn:d", childUri: "urn:p", undeclaredUri: "", childPrefixedName: "p:b", childLocal: "b" },
    {
      rootUri: ns.xpath("namespace-uri(/*)"),
      childUri: ns.xpath("namespace-uri(/*/*[1])"),
      undeclaredUri: ns.xpath("namespace-uri(/*/*[2])"),
      childPrefixedName: ns.xpath("name(/*/*[1])"),
      childLocal: ns.xpath("local-name(/*/*[1])"),
    },
    "namespace URI, prefixed name and local name are readable ONLY through document-level XPath functions; xmlns= resets work");
  add("NS-02", "namespace", "supported", { nodeName: "b" }, { nodeName: nodeNames[0] },
    "Node.name() still returns the LOCAL name; the qualified name, prefix and URI are on the separate accessors (NS-03, NS-05)");
  const NODE_NS = ["namespaceUri", "prefix", "localName", "qualifiedName", "inScopeNamespaces", "declaredNamespaces"];
  add("NS-03", "namespace", "supported",
    { nodeMethods: NODE_NS },
    { nodeMethods: NODE_NS.filter((n) => typeof m.Node.prototype[n] === "function") },
    "moxml-ts#9 puts namespace accessors and in-scope/declared namespace enumeration on Node");
  const rootNode = ns.root();
  const childNode = rootNode.children()[0];
  add("NS-05", "namespace", "supported",
    {
      root: { uri: "urn:d", prefix: "", local: "r", qualified: "r" },
      child: { uri: "urn:p", prefix: "p", local: "b", qualified: "p:b" },
      inScope: [["xml", "http://www.w3.org/XML/1998/namespace"], ["p", "urn:p"], ["", "urn:d"]],
      declared: [["p", "urn:p"], ["", "urn:d"]],
    },
    {
      root: { uri: rootNode.namespaceUri(), prefix: rootNode.prefix(), local: rootNode.localName(), qualified: rootNode.qualifiedName() },
      child: { uri: childNode.namespaceUri(), prefix: childNode.prefix(), local: childNode.localName(), qualified: childNode.qualifiedName() },
      inScope: childNode.inScopeNamespaces().map((b) => [b.prefix, b.uri]),
      declared: rootNode.declaredNamespaces().map((b) => [b.prefix, b.uri]),
    },
    "accessor values; the default namespace has prefix '' and the xml prefix is always in scope");
  const nsAxis = ns.xpathTyped("/*/namespace::*").nodes().map((n) => [n.name(), n.text()]);
  add("NS-04", "namespace", "partial", { namespaceAxis: true },
    { namespaceAxis: nsAxis.length > 0 && nsAxis.every(([a, b]) => a === "" && b === "") },
    "namespace:: axis returns nodes but they expose no prefix/URI (name()/text() are empty), so the axis is not the way to enumerate declarations; use Node.inScopeNamespaces() (NS-05)", NS);

  // ---- attribute reads
  add("ATTR-01", "attribute", "supported", { plain: "v", prefixed: "1", missing: "" },
    {
      plain: ns.xpath("string(/*/@k)"),
      prefixed: ns.xpath("string(/*/@*[local-name()='z'])"),
      missing: ns.xpath("string(/*/@nope)"),
    },
    "attribute values are readable via XPath string(); missing attribute yields '' (indistinguishable from empty value without count())");
  add("ATTR-02", "attribute", "supported", { present: 1, absent: 0, emptyValuePresent: 1 },
    {
      present: ns.xpathCount("/*/@k"),
      absent: ns.xpathCount("/*/@nope"),
      emptyValuePresent: (await m.parse('<a e=""/>')).xpathCount("/a/@e"),
    }, "presence vs empty value is decidable with xpathCount");
  const an = ns.xpathTyped("/*/@k").nodes().map((n) => [n.kind(), n.name(), n.text()]);
  add("ATTR-03", "attribute", "partial",
    {
      attributeNode: [7, "", ""],
      nodeMethods: ["attributes", "getAttribute"],
      first: { name: "k", prefix: "", localName: "k", namespaceUri: "", value: "v" },
      second: { name: "p:z", prefix: "p", localName: "z", namespaceUri: "urn:p", value: "1" },
      k: "v",
      missing: undefined,
    },
    {
      attributeNode: an[0],
      nodeMethods: ["attribute", "attributes", "getAttribute", "hasAttribute", "removeAttribute"].filter((n) => typeof m.Node.prototype[n] === "function"),
      first: rootNode.attributes()[0],
      second: rootNode.attributes()[1],
      k: rootNode.getAttribute("k"),
      missing: rootNode.getAttribute("nope"),
    },
    "Node.attributes() lists name/prefix/localName/namespaceUri/value in document order and getAttribute() reads by name (undefined when absent); XPath attribute nodes still have empty name()/text(); there is still no removeAttribute (BLD-04)",
    NS);
  const dup = await capture(async () => (await m.parse('<a x="1" x="2"/>')).toXml());
  add("ATTR-04", "attribute", "unsafe", { ok: '<a x="1"/>' }, dup,
    "duplicate attribute is accepted and the second silently dropped (not well-formed XML; no error)");

  // ---- ordered mixed content
  const mixed = await m.parse('<a>\n  <b/> t <![CDATA[c<>]]><![CDATA[d]]>e<!--k--><?x y?></a>');
  const seq = mixed.root().children().map((c) => c.kind());
  add("MIX-01", "mixed-content", "supported",
    { kinds: [KIND.text, KIND.element, KIND.text, KIND.cdata, KIND.cdata, KIND.text, KIND.comment, KIND.pi], ws: "\n  ", adjacentText: " t " },
    { kinds: seq, ws: mixed.root().children()[0].text(), adjacentText: mixed.root().children()[2].text() },
    "children() returns text/element/CDATA/comment/PI in document order; whitespace-only text is preserved; adjacent CDATA sections stay separate nodes");
  add("MIX-02", "mixed-content", "partial",
    { cdataText: "", viaXPath: "c<>", comment: "", count: 8 },
    {
      cdataText: mixed.root().children()[3].text(),
      viaXPath: mixed.xpath("string(/a/node()[4])"),
      comment: mixed.root().children()[6].text(),
      count: mixed.xpathCount("/a/node()"),
    },
    "CDATA nodes are identifiable (kind 4) but Node.text() is '' for CDATA, comment and PI; their data is reachable only via XPath string(/path/node()[i]). Comment/PI data likewise");
  add("MIX-03", "mixed-content", "supported", { elementText: "t1xcd<>t2" },
    { elementText: (await m.parse('<a>t1<p:b xmlns:p="u">x</p:b><![CDATA[cd<>]]>t2</a>')).root().text() },
    "element.text() is the concatenated string-value, not mixed-content-aware: codecs need children() for order");

  // ---- builder / serialization
  const b = await m.createDocument();
  const root = b.createElement("p:root");
  root.setAttribute("xmlns:p", "urn:p");
  root.setAttribute("a", '1&<"x');
  const child = b.createElement("child");
  child.setAttribute("p:z", "2");
  child.addChild(b.createText("t<&>"));
  root.addChild(child);
  b.setRoot(root);
  const built = b.toXml();
  add("BLD-01", "builder", "supported",
    { xml: '<p:root xmlns:p="urn:p" a="1&amp;&lt;&quot;x"><child p:z="2">t&lt;&amp;&gt;</child></p:root>' },
    { xml: built },
    "createDocument/createElement/createText/setAttribute/addChild/setRoot serialize with text and attribute escaping; namespace declarations are plain attributes the caller writes");
  const reparsed = await m.parse(built);
  add("BLD-02", "builder", "supported", { uri: "urn:p", attr: "2" },
    { uri: reparsed.xpath("namespace-uri(/*)"), attr: reparsed.xpath("string(/*/*/@*[local-name()='z'])") },
    "built output round-trips through parse with the namespace intact");
  const bad = await capture(() => b.createElement("1 bad name") && "created");
  add("BLD-03", "builder", "supported", { threw: 'invalid element name: "1 bad name"' }, bad, "createElement now validates the name and throws on an invalid XML name");
  add("BLD-04", "builder", "absent",
    { missing: ["createCData", "createComment", "createProcessingInstruction", "removeAttribute"] },
    { missing: ["createCData", "createComment", "createProcessingInstruction", "removeAttribute"].filter((n) => typeof m.Document.prototype[n] !== "function" && typeof m.Node.prototype[n] !== "function") },
    "builder still cannot emit CDATA, comments or PIs and cannot remove an attribute; CDATA output is therefore impossible from the builder (only a parsed CDATA survives toXml). createElementNS/setAttributeNS/declareNamespace now exist (BLD-05)", NS);
  const nb = await m.createDocument();
  const nr = nb.createElementNS("urn:p", "p:r");
  nr.setAttributeNS("urn:q", "q:z", "1");
  nr.addChild(nb.createElementNS("urn:p", "p:c"));
  nr.addChild(nb.createElementNS("", "u"));
  nb.setRoot(nr);
  add("BLD-05", "builder", "supported",
    { xml: '<p:r xmlns:p="urn:p" xmlns:q="urn:q" q:z="1"><p:c xmlns:p="urn:p"/><u/></p:r>' }, { xml: nb.toXml() },
    "createElementNS/setAttributeNS declare the prefix; a child created with createElementNS repeats a declaration already in scope (callers that want compact output use createElement with the bound prefix, as the 07b writer does)");
  const cd = await m.parse("<a><![CDATA[x<y]]></a>");
  add("SER-01", "serialization", "supported", { xml: "<a><![CDATA[x<y]]></a>" }, { xml: cd.toXml() },
    "toXml preserves parsed CDATA sections");
  const decl = await m.parse('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a>é 日</a>');
  add("SER-02", "serialization", "supported",
    { xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a>é 日</a>', builtHasDeclaration: false },
    { xml: decl.toXml(), builtHasDeclaration: built.startsWith("<?xml") },
    "declaration round-trips when parsed; a built document has none");
  add("SER-03", "serialization", "absent", { optionsParam: 0 }, { optionsParam: m.Document.prototype.toXml.length },
    "toXml() takes no options: no indent/pretty-print, no declaration control, no empty-element style, no encoding choice", UP);

  // ---- parser policy
  const x = (xml) => capture(async () => {
    const d = await m.parse(xml);
    return { text: d.xpath("string(/*)").slice(0, 40) };
  });
  add("POL-01", "parser-policy", "supported", { threw: "leptris parse failed (status -2)" }, await x("<a><b></a>"),
    "malformed XML throws; the message carries only a numeric status (no line/column, no model context)");
  const xxe = await x('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>');
  add("POL-02", "parser-policy", "supported", { ok: { text: "&x;" } }, xxe,
    "XXE: external SYSTEM entity is NOT resolved or fetched (no file content in output); the reference stays literal text. It is silently accepted, not rejected");
  const pe = await x('<!DOCTYPE a [<!ENTITY % x SYSTEM "http://127.0.0.1:1/x"> %x;]><a/>');
  add("POL-03", "parser-policy", "supported", { ok: { text: "" } }, pe, "parameter-entity external subset is not fetched");
  add("POL-04", "parser-policy", "supported", { ok: { text: "hello" } }, await x('<!DOCTYPE a [<!ENTITY e "hello">]><a>&e;</a>'),
    "internal general entities are expanded; DOCTYPE is not rejected");
  add("POL-05", "parser-policy", "supported", { ok: { text: "&x;" } }, await x('<!DOCTYPE a [<!ENTITY x "&x;">]><a>&x;</a>'),
    "recursive entity does not loop or throw (left literal)");
  const bomb = (n) => {
    let s = '<!DOCTYPE l [<!ENTITY a0 "aaaaaaaaaa">';
    for (let i = 1; i <= n; i++) s += `<!ENTITY a${i} "${`&a${i - 1};`.repeat(10)}">`;
    return s + `]><l>&a${n};</l>`;
  };
  const bd = await m.parse(bomb(5));
  add("POL-06", "parser-policy", "unsafe", { expandedChars: 1_000_000 }, { expandedChars: bd.xpath("string(/*)").length },
    "entity-expansion limit ABSENT: a 5-level (10^5 x 10 char) bomb expands in full with no cap or error. A 7-level bomb (~100 MB output) measured once at ~10.8 s without refusal (manual run, not repeated here). Codecs need an input-size/DOCTYPE guard before parse", "lutaml/moxml-ts + leptris-rs (parser limits)");
  add("POL-07", "parser-policy", "supported", { threw: "leptris parse failed (status -2)" },
    await capture(async () => (await m.parse("<a>".repeat(20000) + "</a>".repeat(20000))).rootName()),
    "20000-deep nesting is refused with the generic parse error (a depth limit exists; its value and a distinct error code are not exposed)");
  add("POL-08", "parser-policy", "unsafe", { ok: "<p:a/>" }, await capture(async () => (await m.parse("<p:a/>")).toXml()),
    "unbound prefix is accepted (not namespace-well-formed) and undefined entity &nope; becomes literal text; no strict mode");
  add("POL-09", "parser-policy", "absent",
    { parseParams: 1 }, { parseParams: m.parse.length },
    "parse(xml) has no options: no way to forbid DOCTYPE, set entity/depth/size limits or choose strict mode from the facade", UP);

  return { pin: PIN, cases };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { cases } = await runProbe();
    if (process.argv.includes("--json")) console.log(JSON.stringify(cases, null, 2));
    else for (const c of cases) console.log(`${c.match ? "ok  " : "DRIFT"} ${c.id} [${c.face}] ${c.status}: ${c.note}`);
    const by = {};
    for (const c of cases) by[c.status] = (by[c.status] ?? 0) + 1;
    console.error(`cases=${cases.length} drift=${cases.filter((c) => !c.match).length} ${JSON.stringify(by)}`);
    process.exit(cases.every((c) => c.match) ? 0 : 1);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(e?.code === "MOXML_TS_UNAVAILABLE" ? 2 : 1);
  }
}

# XML facade capabilities (moxml-ts probe)

Probe: `node scripts/probe-moxml.mjs` (add `--json` for machine output).
Test: `npm test -- --run test/xml_capabilities`.
Exit codes: 0 all observations match, 1 drift, 2 moxml-ts not installed
(a precise `MOXML_TS_UNAVAILABLE` error; the vitest cases then skip, never pass).

## Pin and install

- `lutaml/moxml-ts` commit `b0183ed9762df4f877b9b0439a6259562985c137`, package version 0.1.0,
  wasm bundles `leptris-v1.6.1` (engine) and `moxml-rs v0.1.1` (model). The probe checks these.
- NOT on npm (`npm view moxml-ts` is 404) and has no releases. A git dependency cannot work:
  `dist/` and `vendor/*-wasm` are git-ignored and produced by `scripts/fetch-wasm.sh` (needs `gh`) + `tsc`.
- `npm pack` also cannot work today: `vendor/*/.gitignore` contains `*`, so the packed tarball
  omits the wasm and the install fails to import. Use a directory install:
  `git checkout b0183ed && bash scripts/fetch-wasm.sh && npm i && npm run build`, then in this repo
  `npm install --no-save <that checkout>`.
- Wasm init is lazy: `await parse(xml)` works under Node with no explicit `initEngine()`.

## Findings (29 cases; 17 supported, 2 partial, 6 absent, 4 unsafe)

| Face | State | Detail |
|---|---|---|
| Namespace URI / prefix | partial | Readable only via document-level XPath (`namespace-uri()`, `name()`, `local-name()`); `Node.name()` is the LOCAL name; no `Node` namespace accessor; `namespace::` nodes have empty name/text (NS-02..04). |
| Attribute reads | partial | Values via XPath `string(/path/@a)`, presence via `xpathCount`; no attribute API, attribute nodes (kind 7) have empty name/text so names and order cannot be listed (ATTR-03). |
| Ordered mixed content | supported | `children()` gives text/element/CDATA/comment/PI in order, whitespace kept, adjacent CDATA separate (MIX-01). `text()` is empty for CDATA/comment/PI; data via `string(/a/node()[i])` (MIX-02). |
| CDATA | partial | Detected (kind 4) and round-trips from parse; builder cannot create CDATA, comments or PIs (BLD-04). |
| Builder / serialization | partial | create/set/add/setRoot with escaping works and round-trips; namespace declarations are caller-written `xmlns:*` attributes; no NS-aware constructors, no `removeAttribute`, no `toXml` options (indent, declaration, encoding) (BLD-04, SER-03). `createElement` accepts invalid names (BLD-03). |
| Parser policy | partial | External entities are NOT fetched (XXE-safe: POL-02/03); malformed and 20000-deep input throw a generic status -2 error (POL-01/07). No entity-expansion limit (POL-06: 10^5x bomb expands fully; a ~100 MB bomb ran ~10.8 s, measured once manually), DOCTYPE accepted, duplicate attributes and unbound prefixes accepted (ATTR-04, POL-08), no parse options to tighten any of it (POL-09). |

## Consequences for 07b/07c

- Reader: use `children()` for order; read namespace, prefix and attributes through XPath expressions built from node positions. Attribute order cannot be recovered.
- Writer: element/attribute/text only through the builder; CDATA, comment and PI output and pretty-printing are absent upstream, so those writer cases are capability refusals until delivered. Validate names with `valid_lexical` before `createElement`.
- Guard input size and reject DOCTYPE before `parse` (no facade policy). Error context (line/column) is absent.

Upstream references: `lutaml/moxml-ts` `src/document.ts` (Node/Document faces), `lutaml/leptris-rs#22`
(namespace/attribute/capability follow-through). moxml-ts was not edited.

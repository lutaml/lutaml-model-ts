# XML facade capabilities (moxml-ts probe)

Probe: `node scripts/probe-moxml.mjs` (add `--json` for machine output).
Test: `npm test -- --run test/xml_capabilities`.
Exit codes: 0 all observations match, 1 drift, 2 moxml-ts not installed
(a precise `MOXML_TS_UNAVAILABLE` error; the vitest cases then skip, never pass).

## Pin and install

- `lutaml/moxml-ts` draft PR #9 head `9a70a2ba9119c7be8545c32e0e7385e6a8100875` (package version 0.1.0),
  a git dependency in `package.json`; `npm ci` runs its `prepare` script (fetches the wasm bundles and builds
  `dist/`). The probe checks the version, the locked commit and a sha256 prefix of each vendored wasm bundle.
- Not on npm. When it is not installed the probe exits 2 with `MOXML_TS_UNAVAILABLE` and the vitest cases skip.
- Wasm init is lazy: `await parse(xml)` works under Node with no explicit `initEngine()`.

## Findings (31 cases; 22 supported, 3 partial, 3 absent, 3 unsafe)

Changed since the 07a pin (b0183ed): `Node` now has namespace accessors and in-scope/declared namespace lists,
`attributes()` and `getAttribute()`, `declareNamespace`, `setAttributeNS`, and `Document.createElementNS`;
`createElement` validates names (BLD-03 is now supported).

| Face | State | Detail |
|---|---|---|
| Namespace URI / prefix | supported | `namespaceUri()`, `prefix()`, `localName()`, `qualifiedName()`, `inScopeNamespaces()`, `declaredNamespaces()` on `Node` (NS-02, NS-03, NS-05). The `namespace::` axis still yields nameless nodes (NS-04, partial). |
| Attribute reads | partial | `attributes()` lists name, prefix, local name, URI and value in document order; `getAttribute(name)`; XPath attribute nodes still have empty name/text; no `removeAttribute` (ATTR-03). |
| Ordered mixed content | supported | `children()` gives text/element/CDATA/comment/PI in order, whitespace kept, adjacent CDATA separate (MIX-01). `text()` is empty for CDATA/comment/PI; data via `string(/a/node()[i])` (MIX-02). |
| CDATA | partial | Detected (kind 4) and round-trips from parse; builder cannot create CDATA, comments or PIs (BLD-04). |
| Builder / serialization | partial | `createElement`/`createElementNS`/`setAttributeNS`/`addChild`/`setRoot` with escaping round-trip; `createElementNS` repeats a declaration already in scope, so the 07b writer tracks bindings and uses `createElement` for a bound prefix (BLD-05). No CDATA/comment/PI creation, no `removeAttribute`, no `toXml` options (BLD-04, SER-03). |
| Parser policy | partial | External entities are NOT fetched (XXE-safe: POL-02/03); malformed and 20000-deep input throw a generic status -2 error (POL-01/07). No entity-expansion limit (POL-06), DOCTYPE accepted, duplicate attributes and unbound prefixes accepted (ATTR-04, POL-08), no parse options (POL-09). |

## Consequences for 07b/07c

- Reader: use `children()` for order and the `Node` namespace/attribute accessors; attribute order is available from `attributes()`.
- Writer: element/attribute/text only through the builder; CDATA, comment and PI output and pretty-printing are absent upstream, so those writer cases are capability refusals until delivered.
- Guard input size and reject DOCTYPE before `parse` (no facade policy). Error context (line/column) is absent.

Upstream references: `lutaml/moxml-ts#9` (Node/Document faces), `lutaml/leptris-rs#22`. moxml-ts was not edited.

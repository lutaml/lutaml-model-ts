# mml-ts pilot: generated TypeScript vs Ruby mml on real MathML

First-slice proof for lutaml-model#1033 (card 07c). TypeScript models and XML
codecs are generated from the real mml LML package (graphs `v3-math-nested`,
`v4-math-nested`, exported from Ruby mml 2.4.7) and checked against Ruby
`Mml::V3` / `Mml::V4` on real MathML. Nothing in `src/` was changed; every
difference below is a finding, not a fix.

## Reproduce

```sh
npm ci && npm run build
node scripts/mml/generate.mjs        # models + xml codecs for v3 (194 models) and v4 (195), strict-tsc compiled
git clone --depth 1 https://github.com/plurimath/{mml2,mml3,mmlcore}-testsuite test/mml/.tmp/corpora/<name>
LML_MML_ROOT=<mml-2.4.7 gem root> node scripts/mml/run.mjs --suite <name> --no-report   # one per suite, may run in parallel
node scripts/mml/run.mjs --report-only                                                    # merged report
npm test -- --run test/mml
```

`run.mjs` runs Ruby (`scripts/mml/ruby_oracle.rb`, `bundle exec ruby -Ilib` in a
lutaml-model checkout with the LML work, `--wave1`) and the generated TS on the
same file, then compares. `test/mml/.tmp/` is git-ignored (`test/mml/.gitignore`).
Graph source: `$LML_MML_FIXTURES` or the wave1 worktree `spec/fixtures/lml_mml`.

Suites run on `*.mml` only (4470 files): mml2 (712, run on V3), mml3 (1675, V3),
mmlcore (2083, V4). `.xml`/`.xhtml` pages in the suites are not MathML documents and are not run.

## What is compared

For each file Ruby `from_xml` then `to_xml`, TS `parse` then `stringify`.

- **tree**: both serialized outputs parsed by moxml-ts into a canonical tree
  (element name+namespace, sorted attributes, text; prefixes ignored). Ruby always
  pretty-prints (`pretty: false` is ignored by mml 2.4.7), so whitespace-only text
  between elements is dropped on both sides; text is never trimmed.
- **data**: Ruby's neutral model dump (the 05a oracle form) vs the TS model dump.
  Ruby reads an absent collection as `[]` and TS as `null`; the comparison treats
  `null`, `[]` and `{"state":"absent"}` as the same (this is why "data exact" is 0 of 4019 passes).
- `pass` = tree equal and data equal under those two rules. Byte equality is 0 of 4019 (TS writes the `mml:` prefix and no indentation; Ruby a default namespace and indentation).
- Two variants: **as-is** (file untouched) and **ns-injected** (only for files whose root `<math>` has no `xmlns`, one attribute is added; written to `.tmp`, the corpus is untouched). The second exists because Ruby accepts a namespace-less `<math>` and TS refuses it; without it 2625 files would only say "refused".
- Nothing else is stripped or rewritten. DOCTYPE files go to TS as they are.

## Numbers (mml 2.4.7, after T4 namespace-less roots, T6 any_attribute)

| suite | ruby | variant | files | pass | refused by name | mismatch |
|---|---|---|---|---|---|---|
| mml2 | V3 | as-is | 712 | 690 | 15 (11 TS only, 4 both) | 7 |
| mml2 | V3 | ns-injected | 712 | 690 | 15 | 7 |
| mml3 | V3 | as-is | 1675 | 1644 | 30 (DOCTYPE) | 1 |
| mmlcore | V4 | as-is | 2083 | 1916 | 115 (2 TS only, 113 both) | 52 |
| mmlcore | V4 | ns-injected | 2035 | 1871 | 113 (1 TS only, 112 both) | 51 |

5717 of 6217 compared files pass. The injected rows overlap the as-is rows on the same files, so do not add across variants.
Remaining mismatch classes: attribute-value whitespace (TS follows the XML spec, libxml2 keeps literal LF/TAB), undefined entity references (input not well-formed), whitespace-only text and empty-text tokens in a few element-only cases. Both sides refuse comments/PIs in ordered content.
First run (before T4/T6), for comparison: mml2 as-is 0/712, mml3 1638/1675, mmlcore as-is 44/2083; 185 mismatches were catch-all attributes, now 0.

## Refused by name (not failures)

| class | count | note |
|---|---|---|
| `refused: doctype` ("DOCTYPE is refused: the parser has no entity-expansion limit") | 30 | all mml3 (`Characters/EntityNames/*`). By design (07b). Nothing was stripped. |
| `refused: root/namespace` (`expected root element math in http://www.w3.org/1998/Math/MathML, found math`) | 2625 | rows of the as-is variant whose root has no `xmlns` (mml2 and mmlcore; Ruby parses them). Ruby accepts any root namespace; TS enforces it (as in the 07b `person-wrong-namespace` override). |
| `refused: malformed XML` (`leptris parse failed (status -2)`) | 18 rows (9 files) | files with several root elements, e.g. mml2 `ErrorHandling/BadChildren/emptyContent1.mml`; libxml2 recovers, the TS parser refuses. |
| both refuse: comments in ordered content | 233 rows | Ruby raises `Lml::RejectedError ... invalid_ordered_content (__lml_content: comment nodes ...)` while the oracle captures ordered content; TS raises `invalid_ordered_content: comments and processing instructions have no ordered-content token` (or the namespace refusal first, as-is). Same named reason on both sides; Ruby's plain `to_xml` for these files was not compared. 124 as-is files contain a comment. |

## Mismatch classes (292 rows)

| class | rows | example |
|---|---|---|
| Catch-all attributes: Ruby `map_all_attributes to: :other_attributes` has no rule in the LML graph, so TS never reads them and silently drops them on write | 185 | mmlcore `crashtests/mozilla/394150-1.mml`: `<emptyset id="emptyset">`, Ruby `other_attributes={"id":"emptyset"}`, TS `null`, attribute absent from TS output |
| Empty or whitespace-only text node: Ruby records an ordered-content text token, TS records none | 59 | mml2 `Topics/WhiteSpace/invChars.mml`: `/mn_value/0/__lml_content` Ruby `[{"attribute":"value","index":0,"kind":"text"}]`, TS `null` (tree equal) |
| Whitespace in values: Ruby (libxml2) keeps literal LF/TAB/CR in attribute values, TS follows the XML spec and normalizes them to spaces | 17 | mmlcore `relations/css-styling/lengths-2.math1.mml` |
| Undefined entity reference (input not well-formed XML): parsers recover differently | 16 | mml2 `ErrorHandling/BadEntities/badEntity1.mml`: Ruby `"&foo;"`, TS `"&foo"` |
| Whitespace-only text: TS keeps it, Ruby drops it | 11 | mml2 `Content/TheoryOfSets/list/list-empty.mml`: Ruby no text, TS `" "` |
| Ordered-content token list differs | 2 | mmlcore `crashtests/mozilla/412237-1.mml` (`ms` element) |
| `xml:lang` read by Ruby into `lang`, not by TS | 1 | mml3 `General/GenAttribs/xmllang1.mml`: Ruby `lang="en-us"` |
| Text split around a comment: Ruby keeps two values, TS joins them | 1 | mmlcore `presentation-markup/mrow/legacy-mrow-like-elements-002.math0.mml` |

Top causes by weight: catch-all attributes (63%), empty-text tokens (20%).

## Findings for the owners of src/ and the exporter (not fixed here)

1. **Exporter / graph gap (lutaml-model, `lib/lutaml/model/lml`)**: `map_all_attributes` in the mml source (`universal_presentation_attributes.rb:42`, `content/wildcard_attributes.rb:16`) is exported as a `hash` attribute `other_attributes` with no XML rule, so TS cannot reproduce it. Failing case above. Either export a catch-all rule kind or have the generator/emitter refuse it by name; today TS loses data without a refusal.
2. **Reader (`src/xml/runtime-source.ts`, ordered-content capture)**: an empty element in an ordered/mixed mapping (`<mo></mo>`, `<mn> </mn>`) yields no text token in TS, one in Ruby. Case: mml3 `Characters/Blocks/00000_C0_Controls_and_Basic_Latin.mml` (`mtd/mo`).
3. **Reader performance (`src/xml/runtime-source.ts`, `kids()`/`el.node.children()` and xpath position paths)**: parse is superlinear. An 8.5 KB table (`Characters/Blocks/00080_C1_Controls_and_Latin-1_Supplement.mml`) takes 0.4-0.6 s warm; mml3 `TortureTests/Complexity/complex3.mml` took 98 s (and 122 s on an earlier run) for parse+write+compare, `TortureTests/Size/m1000.mml` 9 s. A full-corpus run needs about 25 minutes on three parallel processes.
4. **Writer**: output uses the `mml:` prefix and no whitespace; correct as a tree but not byte-identical to Ruby (0 of 4019 passes). No byte replay of Ruby output is possible without a prefix policy.
5. **Reader leniency**: Ruby accepts a root in any namespace; TS refuses (2625 files). Keep, but the corpora show that real MathML often has no `xmlns`; a decision is needed for the product.

## Not covered

Browser run (`node test/browser_mml/run.mjs`), the wasm pins, the XML writer emission (`src/xml/writer*.ts`) and the `examples/mml-ts/` package from the full card text are not part of this first slice. Cross-version runs (mml2/3 on V4, mmlcore on V3) were not run. Ruby `to_xml` output was not compared for files where the oracle refused. Real-time figures were measured on a shared machine and vary.

## Tests

`test/mml/mml.test.ts`: the committed `test/mml/fixtures/{oracle.json,v3-mi-mixed.json,v4-mi-mixed.json}` generate, compile under strict tsc and replay the Ruby oracle for the mixed cases; the 4 MB nested-Math graphs are read from `$LML_MML_FIXTURES` (skipped, never passed, when absent). It also unit-tests the comparison helpers and, when a corpus run exists, checks every row has a known outcome and that no mismatch is unclassified.

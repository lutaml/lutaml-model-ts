// Extension points (not yet present; do not export nonexistent modules):
//   06b: ./lml/index.js        (loadBundle)
//   06c: ./generator/index.js  (generateModels)
//   06d: ./values/index.js     (exact value helpers)
//   06e: ./codecs/index.js     (generateJsonCodecs)
export * from "./contracts.js";
export { PACKAGE_NAME, checkDocumentVersion } from "./version.js";

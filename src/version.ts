import { LML_BUNDLE_VERSION, LML_DOCUMENT_VERSION, LmlError } from "./contracts.js";

export const PACKAGE_NAME = "lutaml-model-ts";

/** Verifies only the top-level version marker of a parsed LML value. */
export function checkDocumentVersion(
  value: unknown,
): "document" | "bundle" {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LmlError({ reason: "invalid_document", location: "" });
  }
  const obj = value as Record<string, unknown>;
  if ("lml_bundle" in obj) {
    if (obj["lml_bundle"] !== LML_BUNDLE_VERSION) {
      throw new LmlError({
        reason: "unsupported_version",
        location: "/lml_bundle",
        detail: String(obj["lml_bundle"]),
      });
    }
    return "bundle";
  }
  if (obj["lml"] === undefined) {
    throw new LmlError({ reason: "invalid_document", location: "/lml" });
  }
  if (obj["lml"] !== LML_DOCUMENT_VERSION) {
    throw new LmlError({
      reason: "unsupported_version",
      location: "/lml",
      detail: String(obj["lml"]),
    });
  }
  return "document";
}

import { LmlError } from "../contracts.js";
import type { ErrorCode } from "../contracts.js";

/** Build an LmlError for an exact-value refusal; `rule` names a limit when one was hit. */
export function valueError(reason: ErrorCode, detail: string, rule?: string): LmlError {
  return new LmlError({ reason, detail, ...(rule === undefined ? {} : { rule }) });
}

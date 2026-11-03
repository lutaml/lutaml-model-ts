import { LmlError } from "../contracts.js";
import type { ErrorCode } from "../contracts.js";

/** Build an LmlError for an exact-value refusal. */
export function valueError(reason: ErrorCode, detail: string): LmlError {
  return new LmlError({ reason, detail });
}

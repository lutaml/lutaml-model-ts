import type { ErrorCode, ErrorDetail } from "../contracts.js";
import { LmlError } from "../contracts.js";

export interface ErrorContext {
  readonly model_id?: string | undefined;
  readonly attribute?: string | undefined;
  readonly format?: string | undefined;
  readonly rule?: string | undefined;
}

/** RFC 6901 pointer from path segments (same escaping as the Ruby validator). */
export function pointer(...parts: readonly (string | number)[]): string {
  return parts
    .map((part) => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
}

/** Throws a named LmlError; context entries that are undefined are omitted. */
export function fail(
  reason: ErrorCode,
  detail: string,
  location: string,
  context: ErrorContext = {},
): never {
  const info: { -readonly [K in keyof ErrorDetail]: ErrorDetail[K] } = {
    reason,
    detail,
    location,
  };
  if (context.model_id !== undefined) info.model_id = context.model_id;
  if (context.attribute !== undefined) info.attribute = context.attribute;
  if (context.format !== undefined) info.format = context.format;
  if (context.rule !== undefined) info.rule = context.rule;
  throw new LmlError(info);
}

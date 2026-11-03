/**
 * Generation-time vetting of regex facet patterns. The runtime wraps a
 * pattern as `^(?:p)$` with the `u` flag; JS has no regex timeout, so a
 * pattern that can backtrack exponentially would hang validation of one
 * attacker-chosen string.
 *
 * Choice (L1): refuse the classic ReDoS shape at generation, instead of
 * bounding input length. A length bound cannot help: `(a+)+b` takes 41 s on a
 * 31 character input, so a bound small enough to be safe would reject valid
 * values, while refusal changes no accepted value. The shape refused is a
 * group that is itself repeated (`*`, `+`, `{n,}`, `{n,m}` with m > 1) and
 * contains a variable quantifier, e.g. `(a+)+`, `(a*)*`, `(a+){2,}`, `(.*x)*`.
 * Not detected (documented gap): overlapping alternation under a repeat, such
 * as `(a|a)*b`.
 */

export interface RegexVerdict {
  readonly ok: boolean;
  readonly why?: string;
  /** An alternation outside every group. */
  readonly topAlternation: boolean;
}

interface Frame {
  variable: boolean;
  alternation: boolean;
}

interface Quantifier {
  readonly min: number;
  readonly max: number;
  readonly end: number;
}

function readQuantifier(src: string, at: number): Quantifier | null {
  const ch = src[at];
  let min: number;
  let max: number;
  let end = at + 1;
  if (ch === "*") {
    min = 0;
    max = Infinity;
  } else if (ch === "+") {
    min = 1;
    max = Infinity;
  } else if (ch === "?") {
    min = 0;
    max = 1;
  } else if (ch === "{") {
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(at));
    if (m === null) return null;
    min = Number(m[1]);
    max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    end = at + m[0].length;
  } else {
    return null;
  }
  if (src[end] === "?") end += 1;
  return { min, max, end };
}

/** Structure scan of a (u-flag) pattern source. */
export function vetPattern(src: string): RegexVerdict {
  const stack: Frame[] = [{ variable: false, alternation: false }];
  let i = 0;
  let topAlternation = false;
  const top = (): Frame => stack[stack.length - 1] as Frame;
  while (i < src.length) {
    const ch = src[i] as string;
    let atomVariable = false;
    let isAtom = true;
    if (ch === "\\") {
      // \p{..}, \P{..}, \u{..}, \k<..> carry braces/brackets that are not quantifiers.
      const m = /^\\(?:[pP]\{[^}]*\}|u\{[0-9a-fA-F]+\}|k<[^>]*>)/.exec(src.slice(i));
      i += m === null ? 2 : m[0].length;
    } else if (ch === "[") {
      i += 1;
      while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (ch === "(") {
      const head = /^\((?:\?(?::|=|!|<=|<!|<[^>=!][^>]*>))?/.exec(src.slice(i));
      i += head === null ? 1 : head[0].length;
      stack.push({ variable: false, alternation: false });
      continue;
    } else if (ch === ")") {
      i += 1;
      const frame = stack.length > 1 ? (stack.pop() as Frame) : { variable: false, alternation: false };
      const q = readQuantifier(src, i);
      if (q !== null) {
        if (q.max > 1 && frame.variable) {
          return { ok: false, topAlternation, why: "a repeated group contains a variable quantifier (nested quantifiers can backtrack exponentially)" };
        }
        i = q.end;
        atomVariable = frame.variable || q.min !== q.max;
      } else {
        atomVariable = frame.variable;
      }
      if (atomVariable) top().variable = true;
      continue;
    } else if (ch === "|") {
      if (stack.length === 1) topAlternation = true;
      i += 1;
      isAtom = false;
    } else {
      i += 1;
    }
    if (!isAtom) continue;
    const q = readQuantifier(src, i);
    if (q !== null) {
      i = q.end;
      if (q.min !== q.max) top().variable = true;
    }
  }
  return { ok: true, topAlternation };
}

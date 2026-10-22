const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parses durations such as "250ms", "2s", or "1h30m" into milliseconds.
 * Components must be adjacent; surrounding whitespace is ignored.
 */
export function parseDuration(input: string): number {
  const text = input.trim();
  if (text === "") throw new SyntaxError("empty duration");
  const component = /(\d+)(ms|s|m|h)/y;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = component.exec(text)) !== null) {
    total += Number(match[1]) * UNIT_MS[match[2]];
    consumed = component.lastIndex;
  }
  if (consumed !== text.length) throw new SyntaxError(`invalid duration: ${input}`);
  return total;
}

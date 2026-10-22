/**
 * Greedy word wrap. Words longer than `width` are split at hyphens when
 * possible, and hard-broken otherwise, so no line exceeds `width`.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean).flatMap((w) => splitLong(w, width))) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function splitLong(word: string, width: number): string[] {
  if (word.length <= width) return [word];
  const hyphen = word.lastIndexOf("-", width - 1);
  const cut = hyphen > 0 ? hyphen + 1 : width;
  return [word.slice(0, cut), ...splitLong(word.slice(cut), width)];
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Shortens `s` to at most `max` characters by replacing the middle with `…`. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…".slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return s.slice(0, head) + "…" + (tail > 0 ? s.slice(-tail) : "");
}

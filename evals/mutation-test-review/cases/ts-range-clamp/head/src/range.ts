/**
 * Parses an HTTP byte range such as "0-499" for a resource of `size` bytes
 * and returns the inclusive [start, end] pair. The end is clamped to the
 * resource.
 */
export function parseRange(spec: string, size: number): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(spec.trim());
  if (!m) throw new SyntaxError(`bad range: ${spec}`);
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), size - 1);
  if (start > end) throw new RangeError(`unsatisfiable range: ${spec}`);
  return [start, end];
}

/** Quotes a field per RFC 4180 when it contains a quote, comma, CR, or LF. */
export function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsvRow(fields: readonly string[]): string {
  return fields.map(escapeField).join(",");
}

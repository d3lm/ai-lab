const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Unpadded base64url (RFC 4648 section 5). */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += ALPHABET[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

/** Decodes unpadded base64url; throws on characters outside the alphabet or a dangling final character. */
export function decodeBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new SyntaxError("invalid base64url length");
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const group = text.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = group[j];
      const v = c === undefined ? 0 : LOOKUP.get(c);
      if (v === undefined) throw new SyntaxError(`invalid base64url character: ${c}`);
      n |= v << (18 - 6 * j);
    }
    const bytes = Math.floor((group.length * 6) / 8);
    for (let k = 0; k < bytes; k++) out.push((n >> (16 - 8 * k)) & 255);
  }
  return new Uint8Array(out);
}

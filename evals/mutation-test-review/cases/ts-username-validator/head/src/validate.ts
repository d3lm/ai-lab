export type UsernameResult =
  | { valid: true }
  | { valid: false; reason: "too_short" | "too_long" | "invalid_chars" | "edge_underscore" };

/**
 * Usernames are 3-20 characters of lowercase letters, digits, and
 * underscores, and may not start or end with an underscore. The reason is
 * shown to the user, so each rule reports its own code.
 */
export function validateUsername(name: string): UsernameResult {
  if (name.length < 3) return { valid: false, reason: "too_short" };
  if (name.length > 20) return { valid: false, reason: "too_long" };
  if (!/^[a-z0-9_]+$/.test(name)) return { valid: false, reason: "invalid_chars" };
  if (name.startsWith("_") || name.endsWith("_")) return { valid: false, reason: "edge_underscore" };
  return { valid: true };
}

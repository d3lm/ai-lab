export function isValidUsername(name: string): boolean {
  return /^[a-z0-9_]{3,20}$/.test(name);
}

export const warnings: string[] = [];

export function warn(message: string): void {
  warnings.push(message);
  console.warn(message);
}

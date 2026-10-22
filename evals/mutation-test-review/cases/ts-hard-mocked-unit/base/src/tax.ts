/** VAT rates by country code, as fractions. */
export const VAT: Record<string, number> = { DE: 0.19, FR: 0.2, GB: 0.2 };

export function vatFor(country: string): number {
  return VAT[country] ?? 0;
}

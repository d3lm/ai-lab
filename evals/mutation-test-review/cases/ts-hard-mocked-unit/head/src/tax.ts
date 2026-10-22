/** VAT rates by country code, as fractions. */
export const VAT: Record<string, number> = { DE: 0.19, FR: 0.2, GB: 0.2, NL: 0.21 };

/** Reduced rates for food, books, and similar categories. */
export const REDUCED_VAT: Record<string, number> = { DE: 0.07, FR: 0.055, NL: 0.09 };

export function vatFor(country: string, reduced = false): number {
  if (reduced) return REDUCED_VAT[country] ?? VAT[country] ?? 0;
  return VAT[country] ?? 0;
}

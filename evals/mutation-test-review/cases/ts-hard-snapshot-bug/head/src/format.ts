/**
 * Formats integer cents as a German-style amount with exactly two decimals,
 * a `.` thousands separator, and the currency symbol after a space:
 * 123456 -> "1.234,56 €". Negative amounts get a leading minus sign.
 */
export function formatMoney(cents: number, symbol = "€"): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimals = rest < 10 ? String(rest) : String(rest);
  return `${negative ? "-" : ""}${grouped},${decimals} ${symbol}`;
}

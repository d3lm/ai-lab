import { vatFor } from "./tax";

export interface Item {
  netCents: number;
  qty: number;
  reducedVat?: boolean;
}

export class PriceCalculator {
  constructor(
    private readonly country: string,
    private readonly loyaltyYears = 0,
  ) {}

  /** 1% off per loyalty year, capped at 10%. */
  loyaltyDiscount(netCents: number): number {
    const pct = Math.min(this.loyaltyYears, 10);
    return Math.round((netCents * pct) / 100);
  }

  /** Gross total in cents: net minus loyalty discount, plus VAT per item. */
  total(items: Item[]): number {
    let gross = 0;
    for (const item of items) {
      const net = item.netCents * item.qty;
      const discounted = net - this.loyaltyDiscount(net);
      gross += Math.round(discounted * (1 + vatFor(this.country, item.reducedVat)));
    }
    return gross;
  }
}

import type { LineItem, Order, OrderRepo } from "./types";

const MAX_COUPON_PERCENT = 50;

/** Coupons are clamped to 0-50% and the discount is rounded to whole cents. */
export function computeTotals(items: LineItem[], couponPercent = 0): Omit<Order, "items"> {
  const subtotalCents = items.reduce((sum, item) => sum + item.unitCents * item.qty, 0);
  const pct = Math.min(Math.max(couponPercent, 0), MAX_COUPON_PERCENT);
  const discountCents = Math.round((subtotalCents * pct) / 100);
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

export class OrderService {
  constructor(private readonly repo: OrderRepo) {}

  async place(items: LineItem[], couponPercent = 0): Promise<Order> {
    if (items.length === 0) throw new Error("cannot place an empty order");
    return this.repo.save({ items, ...computeTotals(items, couponPercent) });
  }
}

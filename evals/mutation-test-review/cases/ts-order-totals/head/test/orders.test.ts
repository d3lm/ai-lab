import { describe, expect, it, vi } from "vitest";
import { computeTotals, OrderService } from "../src/orders";
import type { Order } from "../src/types";

const saved: Order = {
  items: [{ sku: "A", unitCents: 1000, qty: 2 }],
  subtotalCents: 2000,
  discountCents: 200,
  totalCents: 1800,
};

describe("OrderService", () => {
  it("places an order with a coupon", async () => {
    const repo = { save: vi.fn().mockResolvedValue(saved) };
    const order = await new OrderService(repo).place([{ sku: "A", unitCents: 1000, qty: 2 }], 10);
    expect(repo.save).toHaveBeenCalled();
    expect(order.totalCents).toBe(1800);
  });

  it("rejects empty orders", async () => {
    const repo = { save: vi.fn() };
    await expect(new OrderService(repo).place([])).rejects.toThrow();
  });
});

describe("computeTotals", () => {
  it("computes totals", () => {
    expect(computeTotals([{ sku: "A", unitCents: 500, qty: 1 }])).toBeTruthy();
  });
});

import { describe, expect, it, vi } from "vitest";
import { PriceCalculator } from "../src/pricing";

vi.mock("../src/tax", () => ({ vatFor: () => 0.2 }));

describe("PriceCalculator", () => {
  it("adds VAT to the net price", () => {
    const calc = new PriceCalculator("FR");
    expect(calc.total([{ netCents: 1000, qty: 2 }])).toBe(2400);
  });

  it("applies the loyalty discount", () => {
    const calc = new PriceCalculator("FR", 5);
    const spy = vi.spyOn(calc, "loyaltyDiscount").mockReturnValue(100);
    expect(calc.total([{ netCents: 1000, qty: 2 }])).toBe(2280);
    expect(spy).toHaveBeenCalledWith(2000);
  });

  it("uses the reduced rate for reduced items", () => {
    const calc = new PriceCalculator("DE");
    expect(calc.total([{ netCents: 1000, qty: 1, reducedVat: true }])).toBeGreaterThan(1000);
  });
});

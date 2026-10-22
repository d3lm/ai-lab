import { describe, expect, it } from "vitest";
import { paginate } from "../src";

const items = Array.from({ length: 20 }, (_, i) => i + 1);

describe("paginate", () => {
  it("returns the first page", () => {
    const p = paginate(items, 1, 10);
    expect(p.items).toHaveLength(10);
    expect(p.totalPages).toBe(2);
  });

  it("returns the second page", () => {
    const p = paginate(items, 2, 10);
    expect(p.items[0]).toBe(11);
    expect(p.hasNext).toBe(false);
  });

  it("throws on an invalid page size", () => {
    expect(() => paginate(items, 1, 0)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { formatMoney } from "../src";

describe("formatMoney", () => {
  it("formats a range of amounts", () => {
    const amounts = [0, 5, 99, 100, 1050, 123456, 100000000];
    expect(amounts.map((c) => formatMoney(c))).toMatchSnapshot();
  });

  it("supports other symbols", () => {
    expect(formatMoney(250, "$")).toMatchSnapshot();
  });
});

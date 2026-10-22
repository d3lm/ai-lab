import { describe, expect, it } from "vitest";
import { capitalize, truncateMiddle, wrap } from "../src/strings";

describe("wrap", () => {
  it("wraps at the width", () => {
    expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("returns no lines for blank input", () => {
    expect(wrap("   ", 10)).toEqual([]);
  });
});

describe("capitalize", () => {
  it("uppercases the first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
  });
});

describe("truncateMiddle", () => {
  it("leaves short strings alone", () => {
    expect(truncateMiddle("abc", 10)).toBe("abc");
  });

  it("shortens long strings", () => {
    const out = truncateMiddle("abcdefghijklmnop", 9);
    expect(out).toHaveLength(9);
    expect(out).toContain("…");
  });
});

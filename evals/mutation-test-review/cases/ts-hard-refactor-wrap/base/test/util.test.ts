import { describe, expect, it } from "vitest";
import { capitalize, wrap } from "../src/util";

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

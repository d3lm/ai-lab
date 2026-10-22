import { describe, expect, it } from "vitest";
import { parseDuration } from "../src";

describe("parseDuration", () => {
  it.each([
    ["250ms", 250],
    ["2s", 2_000],
    ["3m", 180_000],
    ["1h", 3_600_000],
    ["1h30m", 5_400_000],
    ["1m1s1ms", 61_001],
    ["0s", 0],
    ["12ms", 12],
  ])("parses %j as %d ms", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseDuration("  2s\n")).toBe(2_000);
  });

  it("rejects empty and blank input", () => {
    expect(() => parseDuration("")).toThrow(new SyntaxError("empty duration"));
    expect(() => parseDuration("   ")).toThrow(new SyntaxError("empty duration"));
  });

  it.each(["5", "s", "5x", "1h 30m", "1.5h", "-2s", "2s!"])("rejects %j", (input) => {
    expect(() => parseDuration(input)).toThrow(new SyntaxError(`invalid duration: ${input}`));
  });
});

import { describe, expect, it } from "vitest";
import { parseRange } from "../src/range";

describe("parseRange", () => {
  it("parses a simple range", () => {
    expect(parseRange("0-99", 1000)).toEqual([0, 99]);
  });

  it("rejects malformed specs", () => {
    expect(() => parseRange("abc", 1000)).toThrow(SyntaxError);
  });
});

import { describe, expect, it } from "vitest";
import { decodeBase64Url } from "../src";

describe("decodeBase64Url errors", () => {
  it("rejects characters outside the alphabet", () => {
    expect(() => decodeBase64Url("Zm9v+A")).toThrow(SyntaxError);
  });
});

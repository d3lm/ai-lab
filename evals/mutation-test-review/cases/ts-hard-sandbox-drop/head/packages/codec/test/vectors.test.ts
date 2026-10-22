import { describe, expect, it } from "vitest";
import vectors from "../../../shared/vectors.json";
import { decodeBase64Url, encodeBase64Url } from "../src";

describe("shared base64url vectors", () => {
  for (const { bytes, encoded } of vectors) {
    it(`encodes ${JSON.stringify(encoded)}`, () => {
      expect(encodeBase64Url(new Uint8Array(bytes))).toBe(encoded);
    });

    it(`decodes ${JSON.stringify(encoded)}`, () => {
      expect([...decodeBase64Url(encoded)]).toEqual(bytes);
    });
  }
});

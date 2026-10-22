import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { escapeField, toCsvRow } from "../src";

interface Fixture {
  input: string;
  expected: string;
}

const fixtureDir = new URL("./fixtures/", import.meta.url);
const fixtures = existsSync(fixtureDir)
  ? readdirSync(fixtureDir).filter((name) => name.endsWith(".json"))
  : [];

describe("escapeField", () => {
  for (const name of fixtures) {
    it(`matches fixture ${name}`, () => {
      const { input, expected }: Fixture = JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
      expect(escapeField(input)).toBe(expected);
    });
  }

  it("leaves plain fields alone", () => {
    expect(escapeField("plain")).toBe("plain");
  });
});

describe("toCsvRow", () => {
  it("joins fields with commas", () => {
    expect(toCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });
});

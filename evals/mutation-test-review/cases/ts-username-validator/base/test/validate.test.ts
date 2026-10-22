import { expect, it } from "vitest";
import { isValidUsername } from "../src/validate";

it("accepts a normal username", () => {
  expect(isValidUsername("alice_01")).toBe(true);
});

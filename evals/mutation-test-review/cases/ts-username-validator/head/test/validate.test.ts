import { describe, expect, it } from "vitest";
import { validateUsername } from "../src/validate";

describe("validateUsername", () => {
  it("accepts a normal username", () => {
    expect(validateUsername("alice_01").valid).toBe(true);
  });

  it.each(["a", "x".repeat(30), "Alice", "bob smith", "_alice", "alice_"])("rejects %j", (name) => {
    expect(validateUsername(name).valid).toBe(false);
  });

  it("reports why a name is rejected", () => {
    const result = validateUsername("Alice!");
    expect(result).toHaveProperty("reason");
  });
});

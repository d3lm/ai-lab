import { describe, expect, it } from "vitest";
import { TtlCache } from "../src";

/** Polls until `predicate` holds, failing after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("TtlCache", () => {
  it("returns values before they expire", () => {
    const cache = new TtlCache<string, number>(1_000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("expires entries after the ttl", async () => {
    const cache = new TtlCache<string, number>(50);
    cache.set("a", 1);
    await waitFor(() => cache.get("a") === undefined);
  });

  it("rewriting a key extends its lifetime", async () => {
    const cache = new TtlCache<string, number>(80);
    cache.set("a", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    cache.set("a", 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cache.get("a")).toBe(2);
  });

  it("prune removes expired entries", async () => {
    const cache = new TtlCache<string, number>(30);
    cache.set("a", 1);
    cache.set("b", 2);
    await waitFor(() => cache.prune() > 0);
    expect(cache.size).toBeLessThan(2);
  });
});

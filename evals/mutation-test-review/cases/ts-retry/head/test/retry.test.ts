import { describe, expect, it, vi } from "vitest";
import { HttpError, withRetry } from "../src";

const noSleep = () => Promise.resolve();

describe("withRetry", () => {
  it("returns the value on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { retries: 3, delayMs: 10, sleep: noSleep })).toBe("ok");
  });

  it("retries on server errors", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new HttpError(503)).mockResolvedValue("ok");
    const result = await withRetry(fn, { retries: 3, delayMs: 10, sleep: noSleep });
    expect(result).toBe("ok");
  });

  it("does not retry client errors", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(404));
    try {
      await withRetry(fn, { retries: 3, delayMs: 10, sleep: noSleep });
    } catch (err) {
      expect((err as HttpError).status).toBe(404);
    }
    expect(fn).toHaveBeenCalled();
  });

  it("gives up after the configured retries", async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(500));
    await expect(withRetry(fn, { retries: 2, delayMs: 10, sleep: noSleep })).rejects.toBeInstanceOf(HttpError);
  });
});

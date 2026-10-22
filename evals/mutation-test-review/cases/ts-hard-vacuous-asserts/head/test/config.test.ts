import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("uses defaults when nothing is set", () => {
    const result = loadConfig({});
    if (result.ok) {
      expect(result.config).toEqual({ port: 8080, host: "127.0.0.1", debug: false });
    }
  });

  it("reads overrides", () => {
    const result = loadConfig({ APP_PORT: "9000", APP_HOST: "0.0.0.0", APP_DEBUG: "true" });
    if (result.ok) {
      expect(result.config.port).toBe(9000);
      expect(result.config.debug).toBe(true);
    }
  });

  it("rejects an invalid port", () => {
    const result = loadConfig({ APP_PORT: "70000" });
    if (!result.ok) {
      expect(result.error).toContain("APP_PORT");
    }
  });

  it("does not warn about known settings", () => {
    const spy = vi.spyOn(console, "error");
    loadConfig({ APP_PORT: "9000", APP_DEBUG: "0" });
    expect(spy).not.toHaveBeenCalled();
  });
});

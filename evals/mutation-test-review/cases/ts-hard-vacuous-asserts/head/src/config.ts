import { warn } from "./log";

export interface Config {
  port: number;
  host: string;
  debug: boolean;
}

export type LoadResult = { ok: true; config: Config } | { ok: false; error: string };

const DEFAULTS: Config = { port: 8080, host: "127.0.0.1", debug: false };

/** Reads APP_PORT, APP_HOST and APP_DEBUG. Unknown APP_* variables produce a warning. */
export function loadConfig(env: Record<string, string | undefined>): LoadResult {
  const config = { ...DEFAULTS };
  if (env.APP_PORT !== undefined) {
    const port = Number(env.APP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `APP_PORT must be an integer in 1-65535, got ${env.APP_PORT}` };
    }
    config.port = port;
  }
  if (env.APP_HOST) config.host = env.APP_HOST;
  if (env.APP_DEBUG !== undefined) config.debug = env.APP_DEBUG === "1" || env.APP_DEBUG === "true";
  for (const key of Object.keys(env)) {
    if (key.startsWith("APP_") && !["APP_PORT", "APP_HOST", "APP_DEBUG"].includes(key)) {
      warn(`unknown setting ${key}`);
    }
  }
  return { ok: true, config };
}

import claudeCli from './claude-cli.mjs';
import codexCli from './codex-cli.mjs';
import cursorCli from './cursor-cli.mjs';

export const ADAPTERS = Object.freeze({
  [claudeCli.name]: claudeCli,
  [codexCli.name]: codexCli,
  [cursorCli.name]: cursorCli,
});

export function getAdapter(name) {
  const adapter = ADAPTERS[name];

  if (!adapter) {
    throw new Error(`unknown adapter ${name}`);
  }

  return adapter;
}

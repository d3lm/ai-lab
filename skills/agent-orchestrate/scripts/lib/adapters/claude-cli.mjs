import { readJsonLines } from '../process.mjs';
import { classifyMessage, dryRunArguments, truncate } from './common.mjs';

const BUDGET_SUBTYPES = new Set(['error_max_budget_usd', 'error_max_turns']);

// the session refuses to start without a working sandbox, and no command may retry outside it
export const BASH_SANDBOX_SETTINGS = Object.freeze({
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
});

function buildArgs(profile, { schemaText, resumeSessionId, sessionName, addDirs: extraDirectories = [] }) {
  const args = [...profile.executable, '-p'];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  } else if (sessionName) {
    args.push('--name', sessionName);
  }

  args.push('--model', profile.model);

  if (profile.effort) {
    args.push('--effort', profile.effort);
  }

  const format = profile.outputFormat ?? 'stream-json';

  args.push('--output-format', format);

  if (format === 'stream-json') {
    args.push('--verbose');
  }

  args.push(
    '--json-schema',
    schemaText,
    '--permission-mode',
    profile.permissionMode,
    '--permission-prompts',
    profile.permissionPrompts,
  );

  if (profile.tools) {
    args.push('--tools', profile.tools.join(','));
  }

  if (profile.allowedTools?.length > 0) {
    args.push('--allowedTools', ...profile.allowedTools);
  }

  if (profile.disallowedTools?.length > 0) {
    args.push('--disallowedTools', ...profile.disallowedTools);
  }

  if (profile.maxBudgetUsd) {
    args.push('--max-budget-usd', String(profile.maxBudgetUsd));
  }

  if (profile.bashSandbox) {
    args.push('--settings', JSON.stringify(BASH_SANDBOX_SETTINGS));
  }

  if (profile.settingSources) {
    args.push('--setting-sources', profile.settingSources.join(','));
  }

  if (profile.strictMcpConfig) {
    args.push('--strict-mcp-config');
  }

  if (profile.mcpConfig?.length > 0) {
    args.push('--mcp-config', ...profile.mcpConfig);
  }

  const directories = [...(profile.addDirs ?? []), ...extraDirectories];

  if (directories.length > 0) {
    args.push('--add-dir', ...directories);
  }

  return args;
}

export default {
  name: 'claude-cli',
  adapterVersion: '1',
  binary: 'claude',
  package: '@anthropic-ai/claude-code',
  envVar: 'CLAUDE_CMD',
  versionArgs: ['--version'],
  capabilities: new Set(['resume', 'streaming-events', 'structured-output', 'enforced-cost-limit', 'tool-policy']),

  async probe(profile, { cwd, env }) {
    const problems = [];
    const schemaText = '{"type":"object"}';

    const fresh = await dryRunArguments(buildArgs(profile, { schemaText, sessionName: 'orchestrator-probe' }), {
      cwd,
      env,
      expect: /Input must be provided/i,
    });

    if (!fresh.ok) {
      problems.push(`claude rejected the profile's arguments: ${fresh.output.split('\n').slice(0, 3).join(' ')}`);
    }

    const resumed = await dryRunArguments(
      buildArgs(profile, { schemaText, resumeSessionId: '00000000-0000-4000-8000-000000000000' }),
      { cwd, env, expect: /Input must be provided|No conversation found/i },
    );

    if (!resumed.ok) {
      problems.push(`claude rejected the resume arguments: ${resumed.output.split('\n').slice(0, 3).join(' ')}`);
    }

    return { ok: problems.length === 0, problems };
  },

  buildInvocation(attempt) {
    return {
      argv: buildArgs(attempt.profile, attempt),
      cwd: attempt.cwd,
      stdinFile: attempt.promptFile,
      env: {},
    };
  },

  parseEvent(record) {
    if (record.type === 'system' && record.subtype === 'init') {
      return [
        { type: 'session', sessionId: record.session_id ?? null },
        {
          type: 'init',
          model: record.model ?? null,
          permissionMode: record.permissionMode ?? null,
          tools: record.tools ?? null,
          mcpServers: (record.mcp_servers ?? []).map((server) => `${server.name}:${server.status}`),
          apiKeySource: record.apiKeySource ?? null,
        },
      ];
    }

    if (record.type === 'assistant') {
      const parts = record.message?.content ?? [];
      const text = parts.find((part) => part.type === 'text')?.text;
      const tool = parts.find((part) => part.type === 'tool_use')?.name;

      return [{ type: 'progress', text: truncate(text ?? (tool ? `tool: ${tool}` : '')) }];
    }

    if (record.type === 'result') {
      return [
        { type: 'session', sessionId: record.session_id ?? null },
        { type: 'usage', usage: record.usage ?? null, costUsd: record.total_cost_usd ?? null },
        { type: 'terminal', ok: !record.is_error && record.subtype === 'success', detail: record.subtype ?? null },
      ];
    }

    return [];
  },

  // success is never guessed, so a missing or failed result record is a failure even if the process exited 0
  parseResult({ stdoutFile }) {
    const { records, invalid } = readJsonLines(stdoutFile);
    const init = records.find((record) => record.type === 'system' && record.subtype === 'init');
    const result = records.findLast((record) => record.type === 'result');

    const base = {
      sessionId: result?.session_id ?? init?.session_id ?? null,
      usage: result?.usage ?? null,
      costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
      numTurns: result?.num_turns ?? null,
      permissionDenials: (result?.permission_denials ?? []).map((denial) => denial.tool_name),
      protocolErrors: invalid,
      diagnostics: {
        subtype: result?.subtype ?? null,
        terminalReason: result?.terminal_reason ?? null,
        model: init?.model ?? null,
        permissionMode: init?.permissionMode ?? null,
        tools: init?.tools ?? null,
      },
      payload: null,
      payloadSource: null,
    };

    if (!result) {
      return {
        ...base,
        providerOutcome: 'missing',
        failureClass: 'protocol',
        message: `no result record in ${stdoutFile}`,
      };
    }

    if (result.is_error || result.subtype !== 'success') {
      const text = `${result.subtype ?? ''} ${typeof result.result === 'string' ? result.result : ''} ${result.terminal_reason ?? ''}`;
      const failureClass = BUDGET_SUBTYPES.has(result.subtype) ? 'budget' : classifyMessage(text, 'transient');

      return {
        ...base,
        providerOutcome: 'failure',
        failureClass,
        message: `claude result ${result.subtype ?? 'unknown'}${result.is_error ? ' (is_error)' : ''}`,
      };
    }

    if (result.structured_output !== undefined && result.structured_output !== null) {
      return {
        ...base,
        providerOutcome: 'success',
        payload: result.structured_output,
        payloadSource: 'structured_output',
      };
    }

    // the documented field is structured_output, but an exact JSON result text is also accepted and nothing is repaired
    if (typeof result.result === 'string') {
      try {
        return { ...base, providerOutcome: 'success', payload: JSON.parse(result.result), payloadSource: 'result' };
      } catch {
        // unparseable text falls through to the failure below
      }
    }

    return {
      ...base,
      providerOutcome: 'success',
      failureClass: 'protocol',
      message: `no structured output in ${stdoutFile}`,
    };
  },
};

// Demo stand-in for the Agent SDK's query(): simulated replies, a tool call
// that asks for permission, and made-up usage numbers. Enabled with
// BRIDGE_DEMO=1 so the clients can be tried without a Claude sign-in.

import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

export function demoQuery({ prompt, options }) {
  const sessionId = options.sessionId || options.resume || uuid();
  const out = [];
  let wake = null;
  let closed = false;
  let interrupted = false;
  let mode = options.permissionMode || 'default';

  const push = (m) => {
    out.push({ ...m, session_id: sessionId });
    wake?.();
  };

  async function say(text) {
    for (const word of text.split(/(?<=\s)/)) {
      if (interrupted || closed) return;
      push({
        type: 'stream_event',
        uuid: uuid(),
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } },
      });
      await sleep(35);
    }
    push({ type: 'assistant', uuid: uuid(), parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  }

  async function turn(text) {
    const started = Date.now();
    interrupted = false;
    void text;
    await say(`On it. I went through the project and made the change.\n\nNext I'll run the test suite to make sure nothing else broke.`);

    if (!interrupted && !closed) {
      const toolId = `toolu_demo_${uuid().slice(0, 8)}`;
      const input = { command: 'npm test', description: 'Run the test suite' };
      push({ type: 'assistant', uuid: uuid(), parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input }] } });
      let decision = { behavior: 'allow' };
      // Like the real SDK: a rule passed in allowedTools is not asked about again.
      const preAllowed = (options.allowedTools || []).includes('Bash(npm test)');
      if (mode !== 'bypassPermissions' && !preAllowed && options.canUseTool) {
        const ac = new AbortController();
        decision = await options.canUseTool('Bash', input, {
          signal: ac.signal,
          toolUseID: toolId,
          title: 'Claude wants to run: npm test',
          displayName: 'Run command',
          suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }],
        });
      }
      const allowed = decision.behavior === 'allow';
      push({
        type: 'user',
        uuid: uuid(),
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              is_error: !allowed,
              content: allowed ? '> demo@1.0.0 test\n\n 12 passed, 0 failed (1.8s)' : decision.message || 'Denied by the user.',
            },
          ],
        },
      });
      if (!interrupted && !closed) {
        await say(
          allowed
            ? 'All **12 tests passed**.\n\n- `npm test` finished in 1.8s\n- No failing or skipped tests\n\nThe change is ready. Want me to commit it?'
            : 'Understood, I did not run the command. Tell me how you would like to continue.',
        );
      }
    }

    push({
      type: 'result',
      subtype: 'success',
      uuid: uuid(),
      is_error: false,
      result: '',
      duration_ms: Date.now() - started,
      num_turns: 2,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1840, output_tokens: 212, cache_read_input_tokens: 15200, cache_creation_input_tokens: 0 },
    });
  }

  (async () => {
    push({ type: 'system', subtype: 'init', uuid: uuid(), model: 'demo', permissionMode: mode, cwd: options.cwd });
    for await (const m of prompt) {
      if (closed) break;
      const content = m?.message?.content;
      await turn(typeof content === 'string' ? content : '');
    }
  })().catch(() => {});

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      while (!out.length) {
        if (closed) return { value: undefined, done: true };
        await new Promise((r) => (wake = r));
      }
      return { value: out.shift(), done: false };
    },
    async return() {
      closed = true;
      return { value: undefined, done: true };
    },
    async interrupt() {
      interrupted = true;
    },
    async setPermissionMode(next) {
      mode = next;
    },
    close() {
      closed = true;
      wake?.();
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
      return {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 37, resets_at: inHours(2.4) },
          seven_day: { utilization: 62, resets_at: inHours(80) },
          model_scoped: [{ display_name: 'Fable', utilization: 74, resets_at: inHours(80) }],
          extra_usage: null,
        },
      };
    },
  };
}

// Core hub of the Claude Remote service.
// Owns the Claude Code sessions (through the Claude Agent SDK) and knows nothing
// about how clients connect. Transports (WebSocket for the mobile app, later a
// Telegram bot, ...) talk to it through two calls:
//
//   core.request(type, params)  -> Promise<reply>   run a command (see handlers)
//   core.subscribe(listener)    -> unsubscribe      receive every live event
//
// Every event and reply is a plain JSON object with a `type` field, so a
// transport can forward it as-is or render it for its own medium.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as realSdk from '@anthropic-ai/claude-agent-sdk';
import { demoQuery } from './demo.mjs';
import { desktopSections } from './desktop-sections.mjs';
import { forgetGrants, grantsFor, rememberMode, rememberUpdates } from './grants.mjs';

const DEMO = !!process.env.BRIDGE_DEMO;
// In demo mode Claude's replies are simulated (no sign-in, no usage spent).
const sdk = DEMO ? { ...realSdk, query: demoQuery } : realSdk;

const IDLE_CLOSE_MS = 20 * 60 * 1000; // close an idle Claude process after 20 min
const MAX_FIELD_CHARS = 6000;
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'];

const events = new EventEmitter();
events.setMaxListeners(100);

/** Send an event to every subscribed transport. */
function broadcast(msg) {
  events.emit('event', msg);
}

// ---------------------------------------------------------------- helpers

function clip(value, max = MAX_FIELD_CHARS) {
  if (typeof value === 'string') {
    return value.length > max ? value.slice(0, max) + `\n… (${value.length - max} more characters)` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clip(v, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clip(v, max);
    return out;
  }
  return value;
}

function cleanUserText(text) {
  if (typeof text !== 'string') return '';
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (/^<(command-|local-command|task-notification|side-sessions-event|ci-monitor-event)/.test(t)) return '';
  if (t.startsWith('Caveat: The messages below were generated')) return '';
  // Reports between Claude sessions are stored as user messages, but the user did not write them.
  if (t.startsWith('Another Claude session sent a message') || t.startsWith('<agent-message')) return '';
  return t;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (b?.type === 'text') return b.text;
      if (b?.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Turn one Messages-API style message into flat display items for the app. */
function toItems(role, content, uuid) {
  const items = [];
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  blocks.forEach((b, i) => {
    const id = `${uuid}:${i}`;
    if (!b || typeof b !== 'object') return;
    if (b.type === 'text') {
      if (role === 'user') {
        const text = cleanUserText(b.text);
        if (text) items.push({ kind: 'user', id, text });
      } else if (b.text && b.text.trim()) {
        items.push({ kind: 'assistant', id, text: b.text });
      }
    } else if (b.type === 'image' && role === 'user') {
      items.push({ kind: 'user', id, text: '[image]' });
    } else if (b.type === 'tool_use') {
      items.push({ kind: 'tool', id: b.id, name: b.name, input: clip(b.input ?? {}) });
    } else if (b.type === 'tool_result') {
      items.push({
        kind: 'tool_result',
        id,
        toolUseId: b.tool_use_id,
        isError: !!b.is_error,
        text: clip(toolResultText(b.content)),
      });
    }
  });
  return items;
}

/** Fold tool_result items into their tool item so a list is ready to render. */
function mergeItems(list, incoming) {
  for (const item of incoming) {
    if (item.kind === 'tool_result') {
      const tool = list.findLast((x) => x.kind === 'tool' && x.id === item.toolUseId);
      if (tool) {
        tool.result = { text: item.text, isError: item.isError };
        continue;
      }
    }
    if (!list.some((x) => x.id === item.id && x.kind === item.kind)) list.push(item);
  }
  return list;
}

async function readHistory(sessionId) {
  const messages = await sdk.getSessionMessages(sessionId);
  const list = [];
  for (const m of messages) {
    if (m.parent_tool_use_id) continue; // subagent traffic
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const content = m.message?.content;
    mergeItems(list, toItems(m.type, content, m.uuid));
  }
  return list;
}

// Reading a long transcript is slow, so keep the parsed result until the file changes.
const historyCache = new Map(); // sessionId -> { key, items }

async function cachedHistory(sessionId) {
  const info = await sdk.getSessionInfo(sessionId).catch(() => null);
  const key = info ? `${info.lastModified}:${info.fileSize ?? ''}` : null;
  const hit = historyCache.get(sessionId);
  if (key && hit && hit.key === key) return hit.items;
  const items = await readHistory(sessionId);
  if (key) {
    historyCache.delete(sessionId);
    historyCache.set(sessionId, { key, items });
    if (historyCache.size > 12) historyCache.delete(historyCache.keys().next().value);
  }
  return items;
}

/** The newest `limit` items that come before index `before` (default: the end). */
function pageOf(all, before, limit) {
  const end = Math.max(0, Math.min(all.length, Number.isInteger(before) ? before : all.length));
  const size = Math.min(500, Math.max(1, Number(limit) || 60));
  const start = Math.max(0, end - size);
  return { items: all.slice(start, end), start, total: all.length };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- live sessions

/** @type {Map<string, LiveSession>} */
const live = new Map();
/** requestId -> { sessionId, payload, resolve } */
const pendingPermissions = new Map();

class LiveSession {
  constructor({ sessionId, cwd, resume, permissionMode, model, items }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.permissionMode = permissionMode || 'default';
    this.model = model || null;
    this.state = 'idle';
    this.items = items || [];
    this.lastResult = null;
    this.closed = false;
    this.inbox = [];
    this.wake = null;
    this.idleTimer = null;

    const self = this;
    async function* input() {
      while (!self.closed) {
        if (self.inbox.length) {
          yield self.inbox.shift();
        } else {
          await new Promise((resolve) => (self.wake = resolve));
        }
      }
    }

    const options = {
      cwd,
      permissionMode: this.permissionMode,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      canUseTool: (toolName, toolInput, opts) => this.askPermission(toolName, toolInput, opts),
      stderr: (line) => {
        if (process.env.BRIDGE_DEBUG) console.error(`[claude ${sessionId.slice(0, 8)}] ${line}`);
      },
    };
    if (process.env.BRIDGE_CLAUDE_PATH) options.pathToClaudeCodeExecutable = process.env.BRIDGE_CLAUDE_PATH;
    if (model) options.model = model;
    if (resume) {
      options.resume = sessionId;
      // A resumed process starts with no memory of what the user granted before
      // (mode, "Always allow" rules): give it back, or it asks for all of it again.
      const granted = grantsFor(sessionId);
      if (!permissionMode && granted.mode) {
        this.permissionMode = granted.mode;
        options.permissionMode = granted.mode;
      }
      if (granted.rules.length) options.allowedTools = granted.rules;
      if (granted.dirs.length) options.additionalDirectories = granted.dirs;
    } else {
      options.sessionId = sessionId;
      rememberMode(sessionId, this.permissionMode);
    }

    this.q = sdk.query({ prompt: input(), options });
    this.pump();
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.state === 'idle') this.close('idle timeout');
      else this.touch();
    }, IDLE_CLOSE_MS);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    broadcast({ type: 'state', sessionId: this.sessionId, state });
  }

  emitItems(items) {
    if (!items.length) return;
    mergeItems(this.items, items);
    broadcast({ type: 'items', sessionId: this.sessionId, items });
  }

  sendPrompt(text) {
    const id = `local-${crypto.randomUUID()}`;
    this.emitItems([{ kind: 'user', id: `${id}:0`, text }]);
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    });
    this.wake?.();
    this.setState('running');
    this.touch();
  }

  async pump() {
    try {
      for await (const m of this.q) this.handle(m);
    } catch (err) {
      if (!this.closed) {
        this.emitItems([
          { kind: 'result', id: `err-${crypto.randomUUID()}`, isError: true, text: String(err?.message || err) },
        ]);
      }
    } finally {
      this.close('stream ended');
    }
  }

  handle(m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.model = m.model || this.model;
          this.permissionMode = m.permissionMode || this.permissionMode;
          broadcast({
            type: 'session_meta',
            sessionId: this.sessionId,
            model: this.model,
            permissionMode: this.permissionMode,
            cwd: this.cwd,
          });
        } else if (m.subtype === 'status' && m.permissionMode) {
          this.permissionMode = m.permissionMode;
          rememberMode(this.sessionId, m.permissionMode);
          broadcast({ type: 'session_meta', sessionId: this.sessionId, permissionMode: m.permissionMode });
        }
        break;
      case 'stream_event': {
        if (m.parent_tool_use_id) break;
        const ev = m.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          broadcast({ type: 'stream', sessionId: this.sessionId, text: ev.delta.text });
        }
        break;
      }
      case 'assistant':
        if (m.parent_tool_use_id) break;
        broadcast({ type: 'stream_end', sessionId: this.sessionId });
        this.emitItems(toItems('assistant', m.message?.content, m.uuid));
        if (m.error) {
          this.emitItems([{ kind: 'result', id: `${m.uuid}:err`, isError: true, text: `Error: ${m.error}` }]);
        }
        break;
      case 'user':
        if (m.parent_tool_use_id) break;
        // Only tool results: prompts we sent were already shown.
        this.emitItems(toItems('user', m.message?.content, m.uuid).filter((i) => i.kind === 'tool_result'));
        break;
      case 'result': {
        broadcast({ type: 'stream_end', sessionId: this.sessionId });
        const isError = m.subtype !== 'success' || !!m.is_error;
        this.lastResult = {
          costUsd: m.total_cost_usd ?? null,
          durationMs: m.duration_ms ?? null,
          numTurns: m.num_turns ?? null,
          usage: m.usage ?? null,
          modelUsage: m.modelUsage ?? null,
        };
        this.emitItems([
          {
            kind: 'result',
            id: `${m.uuid}:result`,
            isError,
            text: isError ? (m.result || (m.errors || []).join('\n') || m.subtype) : '',
            ...this.lastResult,
          },
        ]);
        this.setState('idle');
        usageCache = null;
        broadcastSessions();
        break;
      }
      case 'rate_limit_event':
        broadcast({ type: 'rate_limit', info: m.rate_limit_info });
        break;
    }
  }

  askPermission(toolName, toolInput, opts) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const payload = {
        type: 'permission_request',
        sessionId: this.sessionId,
        requestId,
        toolName,
        input: clip(toolInput),
        title: opts.title || null,
        displayName: opts.displayName || null,
        description: opts.description || null,
        reason: opts.decisionReason || null,
        blockedPath: opts.blockedPath || null,
        canAlways: Array.isArray(opts.suggestions) && opts.suggestions.length > 0 && !opts.defaultToNo,
      };
      const finish = (result, how = {}) => {
        if (!pendingPermissions.delete(requestId)) return;
        broadcast({ type: 'permission_resolved', sessionId: this.sessionId, requestId, toolName, ...how });
        const stillWaiting = [...pendingPermissions.values()].some((p) => p.sessionId === this.sessionId);
        if (!this.closed) this.setState(stillWaiting ? 'requires_action' : 'running');
        resolve(result);
      };
      pendingPermissions.set(requestId, {
        sessionId: this.sessionId,
        payload,
        respond: (decision) => {
          const how = { by: 'remote', via: decision.via || null, outcome: outcomeOf(decision) };
          if (decision.behavior === 'deny') {
            finish({ behavior: 'deny', message: decision.message || 'The user denied this action.' }, how);
          } else {
            const updatedInput = { ...toolInput };
            if (decision.answers && typeof decision.answers === 'object') updatedInput.answers = decision.answers;
            const result = { behavior: 'allow', updatedInput };
            if (decision.behavior === 'allow_always' && payload.canAlways) {
              result.updatedPermissions = opts.suggestions;
              rememberUpdates(this.sessionId, opts.suggestions);
            }
            finish(result, how);
          }
        },
      });
      opts.signal?.addEventListener('abort', () =>
        finish({ behavior: 'deny', message: 'The request was cancelled.' }, { by: 'claude', outcome: 'cancelled' }),
      );
      this.setState('requires_action');
      broadcast(payload);
    });
  }

  async interrupt() {
    try {
      await this.q.interrupt();
    } catch {}
  }

  async setMode(mode) {
    await this.q.setPermissionMode(mode);
    this.permissionMode = mode;
    rememberMode(this.sessionId, mode);
    broadcast({ type: 'session_meta', sessionId: this.sessionId, permissionMode: mode });
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.wake?.();
    for (const [id, p] of pendingPermissions) {
      if (p.sessionId === this.sessionId) {
        pendingPermissions.delete(id);
        broadcast({ type: 'permission_resolved', sessionId: this.sessionId, requestId: id, by: 'claude', outcome: 'cancelled' });
      }
    }
    try {
      this.q.close();
    } catch {}
    if (live.get(this.sessionId) === this) live.delete(this.sessionId);
    broadcast({ type: 'stream_end', sessionId: this.sessionId });
    broadcast({ type: 'state', sessionId: this.sessionId, state: 'idle' });
    if (process.env.BRIDGE_DEBUG) console.log(`session ${this.sessionId} closed (${reason})`);
  }
}

async function ensureLive(sessionId) {
  const existing = live.get(sessionId);
  if (existing && !existing.closed) return existing;
  const info = await sdk.getSessionInfo(sessionId);
  if (!info) throw new Error('Session not found on this computer.');
  if (!info.cwd || !fs.existsSync(info.cwd)) {
    throw new Error(`The session's folder no longer exists: ${info.cwd || '(unknown)'}`);
  }
  const items = await readHistory(sessionId);
  const session = new LiveSession({ sessionId, cwd: info.cwd, resume: true, items });
  live.set(sessionId, session);
  return session;
}

// ---------------------------------------------------------------- session list

async function sessionList() {
  const all = await sdk.listSessions({ limit: 300 });
  const seen = new Set();
  const desktop = desktopSections(); // sections from the Claude desktop app sidebar
  const list = all.map((s) => {
    seen.add(s.sessionId);
    const l = live.get(s.sessionId);
    return {
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || 'Untitled session',
      cwd: s.cwd || null,
      branch: s.gitBranch || null,
      section: s.tag || desktop.get(s.sessionId) || null,
      archived: !!s.archived,
      lastModified: s.lastModified,
      state: l ? l.state : 'idle',
      live: !!l,
    };
  });
  // Brand-new sessions may not be on disk yet.
  for (const l of live.values()) {
    if (seen.has(l.sessionId)) continue;
    const first = l.items.find((i) => i.kind === 'user');
    list.unshift({
      id: l.sessionId,
      title: first ? first.text.slice(0, 80) : 'New session',
      cwd: l.cwd,
      branch: null,
      section: null,
      archived: false,
      lastModified: Date.now(),
      state: l.state,
      live: true,
    });
  }
  list.sort((a, b) => b.lastModified - a.lastModified);
  return list;
}

let sessionsTimer = null;
function broadcastSessions() {
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(async () => {
    try {
      broadcast({ type: 'sessions', sessions: await sessionList() });
    } catch {}
  }, 400);
}

// ---------------------------------------------------------------- usage

let usageCache = null; // { at, data }

async function getUsage() {
  if (usageCache && Date.now() - usageCache.at < 30_000) return usageCache.data;
  const method = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
  let q = [...live.values()].find((l) => !l.closed)?.q;
  let temp = null;
  if (!q) {
    // No Claude process running: start a throwaway one that never gets a prompt.
    let release;
    const never = new Promise((resolve) => (release = resolve));
    async function* idle() {
      await never;
    }
    const options = { cwd: os.homedir(), settingSources: [] };
    if (process.env.BRIDGE_CLAUDE_PATH) options.pathToClaudeCodeExecutable = process.env.BRIDGE_CLAUDE_PATH;
    temp = sdk.query({ prompt: idle(), options });
    temp.release = release;
    q = temp;
  }
  try {
    if (typeof q[method] !== 'function') throw new Error('This SDK version does not expose usage data.');
    const u = await withTimeout(q[method]({ skipBehaviors: true }), 30_000, 'Usage request');
    const data = {
      subscriptionType: u.subscription_type ?? null,
      rateLimitsAvailable: !!u.rate_limits_available,
      rateLimits: u.rate_limits ?? null,
      fetchedAt: Date.now(),
    };
    usageCache = { at: Date.now(), data };
    return data;
  } finally {
    if (temp) {
      temp.release();
      try {
        temp.close();
      } catch {}
    }
  }
}

// ---------------------------------------------------------------- folders

function listDirs(target) {
  if (!target) {
    const roots = [];
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
        const root = `${letter}:\\`;
        try {
          if (fs.existsSync(root)) roots.push({ name: root, path: root });
        } catch {}
      }
    } else {
      roots.push({ name: '/', path: '/' });
    }
    return { path: null, parent: null, home: os.homedir(), dirs: roots };
  }
  const resolved = path.resolve(target);
  const dirs = fs
    .readdirSync(resolved, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && !d.name.startsWith('$'))
    .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 300);
  const parent = path.dirname(resolved);
  return { path: resolved, parent: parent === resolved ? '' : parent, home: os.homedir(), dirs };
}

// ---------------------------------------------------------------- protocol

const handlers = {
  async list_sessions() {
    return { type: 'sessions', sessions: await sessionList() };
  },

  // Returns the newest page of a session. Older pages come from load_older.
  async open_session({ sessionId, limit }) {
    const l = live.get(sessionId);
    const all = l ? l.items : await cachedHistory(sessionId);
    const { items, start, total } = pageOf(all, undefined, limit);
    const pending = [...pendingPermissions.values()].filter((p) => p.sessionId === sessionId).map((p) => p.payload);
    return {
      type: 'history',
      sessionId,
      items,
      start,
      total,
      state: l ? l.state : 'idle',
      model: l?.model || null,
      permissionMode: l?.permissionMode || null,
      lastResult: l?.lastResult || null,
      pending,
    };
  },

  async load_older({ sessionId, before, limit }) {
    const l = live.get(sessionId);
    const all = l ? l.items : await cachedHistory(sessionId);
    return { type: 'older', sessionId, ...pageOf(all, Number(before), limit) };
  },

  async new_session({ cwd, prompt, permissionMode, model }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error('That folder does not exist on the computer.');
    }
    if (!prompt || !String(prompt).trim()) throw new Error('Type a first message for the session.');
    const mode = PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'default';
    const sessionId = crypto.randomUUID();
    const session = new LiveSession({ sessionId, cwd: path.resolve(cwd), resume: false, permissionMode: mode, model });
    live.set(sessionId, session);
    session.sendPrompt(String(prompt));
    broadcastSessions();
    return { type: 'session_created', sessionId, cwd: session.cwd };
  },

  async send({ sessionId, text }) {
    if (!text || !String(text).trim()) throw new Error('Empty message.');
    const session = await ensureLive(sessionId);
    session.sendPrompt(String(text));
    broadcastSessions();
    return { type: 'ok' };
  },

  async permission_response({ requestId, behavior, message, answers, via }) {
    const pending = pendingPermissions.get(requestId);
    if (!pending) throw new Error('That request was already answered.');
    if (!['allow', 'allow_always', 'deny'].includes(behavior)) throw new Error('Unknown decision.');
    pending.respond({ behavior, message, answers, via: typeof via === 'string' ? via.slice(0, 20) : null });
    return { type: 'ok' };
  },

  async interrupt({ sessionId }) {
    await live.get(sessionId)?.interrupt();
    return { type: 'ok' };
  },

  async set_mode({ sessionId, mode }) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error('Unknown permission mode.');
    const session = await ensureLive(sessionId);
    await session.setMode(mode);
    return { type: 'ok' };
  },

  async rename({ sessionId, title }) {
    if (!title || !String(title).trim()) throw new Error('Title is empty.');
    await sdk.renameSession(sessionId, String(title).trim());
    broadcastSessions();
    return { type: 'ok' };
  },

  async set_section({ sessionId, section }) {
    const tag = section && String(section).trim() ? String(section).trim() : null;
    await sdk.tagSession(sessionId, tag);
    broadcastSessions();
    return { type: 'ok' };
  },

  async archive({ sessionId, archived }) {
    const fn = archived ? sdk.archiveSession : sdk.unarchiveSession;
    if (typeof fn !== 'function') throw new Error('Archiving is not supported by this SDK version.');
    await fn(sessionId);
    broadcastSessions();
    return { type: 'ok' };
  },

  async delete_session({ sessionId }) {
    live.get(sessionId)?.close('deleted');
    await sdk.deleteSession(sessionId);
    forgetGrants(sessionId);
    broadcastSessions();
    return { type: 'ok' };
  },

  async stop_process({ sessionId }) {
    live.get(sessionId)?.close('stopped by user');
    broadcastSessions();
    return { type: 'ok' };
  },

  async get_usage() {
    return { type: 'usage', usage: await getUsage() };
  },

  async list_dirs({ path: target }) {
    return { type: 'dirs', ...listDirs(target) };
  },
};

// ---------------------------------------------------------------- desktop approvals
// Permission prompts from Claude sessions this service does NOT run (the desktop
// app, a terminal) arrive through a Claude Code hook: hook/permission-hook.mjs
// posts them here and waits. They join the same pending list, so every client
// shows them and can answer.

const desktopApprovals = { enabled: true, waitSeconds: 300, save: null };

// A prompt answered on the computer itself must disappear from the phone and
// Telegram. Claude does not always end the waiting hook when that happens, so
// the session's own record (its transcript file) is watched as well: once the
// tool call has a result there, allowed or denied, the request is over.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const TRANSCRIPT_POLL_MS = 2000;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Was a finished tool call allowed or refused? Claude writes a refusal as an error result. */
function resultOutcome(part) {
  if (!part.is_error) return 'allowed';
  const text = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
  return /doesn.t want to proceed|denied|rejected|declined|not allowed|permission/i.test(text) ? 'denied' : 'allowed';
}

/** How a remote answer is described to the clients. */
function outcomeOf(decision) {
  if (decision.behavior === 'deny') return 'denied';
  if (decision.answers) return 'answered';
  return decision.behavior === 'allow_always' ? 'allowed_always' : 'allowed';
}

/**
 * Tool calls in the newest part of a transcript that match this tool and input.
 * Returns { calls: Set<toolUseId>, done: Set<toolUseId with a result> }, or null
 * when the file cannot be read.
 */
function matchingToolCalls(transcriptPath, toolName, inputKey) {
  let text;
  try {
    const size = fs.statSync(transcriptPath).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  const calls = new Set();
  const results = new Map(); // tool_use_id -> 'allowed' | 'denied'
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use') && !line.includes('tool_result')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // the first line of the tail may be cut
    }
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && part.name === toolName && stable(part.input ?? {}) === inputKey) calls.add(part.id);
      else if (part?.type === 'tool_result' && part.tool_use_id) results.set(part.tool_use_id, resultOutcome(part));
    }
  }
  const done = new Map([...calls].filter((id) => results.has(id)).map((id) => [id, results.get(id)]));
  return { calls, done };
}

/**
 * Ask the clients about a permission prompt from an outside session.
 * Resolves with a hook decision ({ behavior: 'allow' | 'deny', ... }) or null,
 * meaning "no remote answer: let Claude show its normal prompt".
 */
function externalPermission(hookInput, onAbort) {
  const sessionId = String(hookInput?.session_id || '');
  const toolName = String(hookInput?.tool_name || '');
  if (!desktopApprovals.enabled || !sessionId || !toolName) return Promise.resolve(null);
  if (live.has(sessionId)) return Promise.resolve(null); // our own session: already asked through the SDK

  const suggestions = Array.isArray(hookInput.permission_suggestions) ? hookInput.permission_suggestions : [];
  const requestId = crypto.randomUUID();
  const payload = {
    type: 'permission_request',
    sessionId,
    requestId,
    toolName,
    input: clip(hookInput.tool_input && typeof hookInput.tool_input === 'object' ? hookInput.tool_input : {}),
    title: toolName === 'AskUserQuestion' ? 'Claude has a question' : `Claude wants to use ${toolName}`,
    displayName: null,
    description: `Asked by a session running on the computer${hookInput.cwd ? ` in ${hookInput.cwd}` : ''}, outside this app.`,
    reason: null,
    blockedPath: null,
    canAlways: suggestions.length > 0,
    source: 'desktop',
  };

  // Watch the transcript for the answer being given on the computer.
  const transcript =
    typeof hookInput.transcript_path === 'string' && hookInput.transcript_path.endsWith('.jsonl') ? hookInput.transcript_path : null;
  const toolUseId = typeof hookInput.tool_use_id === 'string' ? hookInput.tool_use_id : null;
  const inputKey = stable(hookInput.tool_input && typeof hookInput.tool_input === 'object' ? hookInput.tool_input : {});
  // Identical calls that finished earlier in the session are not this request.
  const before = transcript ? matchingToolCalls(transcript, toolName, inputKey)?.done ?? new Set() : new Set();

  return new Promise((resolve) => {
    let timer = null;
    let watcher = null;
    const finish = (result, how = {}) => {
      if (!pendingPermissions.delete(requestId)) return;
      clearTimeout(timer);
      clearInterval(watcher);
      broadcast({ type: 'permission_resolved', sessionId, requestId, toolName, source: 'desktop', ...how });
      resolve(result);
    };
    /** The answer given on the computer, read from the transcript (null = not written yet). */
    const answeredHere = () => {
      if (!transcript) return null;
      const now = matchingToolCalls(transcript, toolName, inputKey);
      if (!now) return null;
      if (toolUseId) return now.done.get(toolUseId) ?? null;
      for (const [id, outcome] of now.done) if (!before.has(id)) return outcome;
      return null;
    };
    pendingPermissions.set(requestId, {
      sessionId,
      payload,
      respond: (decision) => {
        const how = { by: 'remote', via: decision.via || null, outcome: outcomeOf(decision) };
        if (decision.behavior === 'deny') {
          finish({ behavior: 'deny', message: decision.message || 'The user denied this action remotely.' }, how);
        } else if (decision.answers && typeof decision.answers === 'object') {
          // An answered question: Claude reads the answers from the tool input.
          finish({ behavior: 'allow', updatedInput: { ...(hookInput.tool_input || {}), answers: decision.answers } }, how);
        } else if (decision.behavior === 'allow_always' && suggestions.length) {
          finish({ behavior: 'allow', updatedPermissions: suggestions }, how);
        } else {
          finish({ behavior: 'allow' }, how);
        }
      },
    });
    timer = setTimeout(() => finish(null, { by: 'timeout', outcome: 'expired' }), desktopApprovals.waitSeconds * 1000);
    if (transcript) {
      watcher = setInterval(() => {
        const outcome = answeredHere();
        if (outcome) finish(null, { by: 'computer', outcome });
      }, TRANSCRIPT_POLL_MS);
    }
    // Claude ended the waiting hook: the prompt was answered (or cancelled) on the
    // computer. A refusal is written to the transcript at once, an approval only
    // after the tool has run; look briefly, then report it without the detail.
    onAbort?.(() => {
      let tries = 0;
      const look = () => {
        const outcome = answeredHere();
        if (outcome || ++tries >= 6) finish(null, { by: 'computer', outcome: outcome || 'answered_here' });
        else setTimeout(look, 500);
      };
      look();
    });
    broadcast(payload);
  });
}

handlers.get_desktop_approvals = async () => ({
  type: 'desktop_approvals',
  enabled: desktopApprovals.enabled,
  waitSeconds: desktopApprovals.waitSeconds,
});

handlers.set_desktop_approvals = async ({ enabled }) => {
  desktopApprovals.enabled = !!enabled;
  try {
    desktopApprovals.save?.(desktopApprovals.enabled);
  } catch {}
  const msg = { type: 'desktop_approvals', enabled: desktopApprovals.enabled, waitSeconds: desktopApprovals.waitSeconds };
  broadcast(msg);
  return msg;
};

// ---------------------------------------------------------------- public API

export const core = {
  demo: DEMO,

  /** Facts a transport can show after a client signs in. */
  info() {
    return { host: process.env.BRIDGE_HOST_NAME || os.hostname(), home: os.homedir(), platform: process.platform, demo: DEMO };
  },

  /** Run a command. Rejects with an Error whose message is safe to show the user. */
  async request(type, params = {}) {
    const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
    if (!handler) throw new Error(`Unknown request: ${type}`);
    return handler(params);
  },

  /** Receive every live event. Returns a function that stops the subscription. */
  subscribe(listener) {
    events.on('event', listener);
    return () => events.off('event', listener);
  },

  /** Settings for prompts from outside sessions (see "desktop approvals" above). */
  configureDesktopApprovals({ enabled, waitSeconds, save }) {
    if (typeof enabled === 'boolean') desktopApprovals.enabled = enabled;
    if (Number(waitSeconds) > 0) desktopApprovals.waitSeconds = Math.min(3600, Number(waitSeconds));
    if (save) desktopApprovals.save = save;
  },

  externalPermission,

  /** Permission requests still waiting for an answer (send to a client that just connected). */
  pendingPermissions() {
    return [...pendingPermissions.values()].map((p) => p.payload);
  },

  shutdown() {
    for (const l of [...live.values()]) l.close('shutdown');
  },
};

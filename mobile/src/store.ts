import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type {
  ChatState,
  DirListing,
  Item,
  PermissionMode,
  PermissionRequest,
  RateLimitInfo,
  SessionInfo,
  SessionState,
  Usage,
} from './protocol';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export type AppState = {
  ready: boolean; // saved credentials loaded
  status: ConnStatus;
  error: string | null;
  address: string;
  host: string | null;
  home: string | null;
  sessions: SessionInfo[];
  sessionsLoaded: boolean;
  chats: Record<string, ChatState>;
  permissions: PermissionRequest[];
  usage: Usage | null;
  usageError: string | null;
  usageLoading: boolean;
  rateLimit: RateLimitInfo | null;
  /** Forward permission prompts from desktop app / terminal sessions. null = not known yet. */
  desktopApprovals: boolean | null;
  /** A request answered somewhere else (the computer, Telegram): shown briefly. */
  note: { text: string; sessionId: string; at: number } | null;
  /** When the list of waiting requests was last received in full from the computer. */
  syncedAt: number;
};

const ADDRESS_KEY = 'claude-remote.address';
const TOKEN_KEY = 'claude-remote.token';
const PAGE = 60; // messages loaded at a time
const REFRESH_MS = 10_000; // how often to pick up work done from other clients

async function saveToken(token: string | null) {
  if (Platform.OS === 'web') {
    if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
    else await AsyncStorage.removeItem(TOKEN_KEY);
  } else if (token) {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
}

async function loadToken(): Promise<string | null> {
  return Platform.OS === 'web' ? AsyncStorage.getItem(TOKEN_KEY) : SecureStore.getItemAsync(TOKEN_KEY);
}

/**
 * When the app runs as a website, ask its host (mobile/service) where the
 * Claude Remote service is: GET config.json -> { serverHost, serverPort }.
 * An empty serverHost means the same computer the page came from.
 */
async function defaultWebAddress(): Promise<string> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return '';
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok) return '';
    const cfg = await res.json();
    const host = String(cfg.serverHost || window.location.hostname);
    const port = Number(cfg.serverPort);
    return host && port ? `${host}:${port}` : '';
  } catch {
    return '';
  }
}

function emptyChat(): ChatState {
  return {
    items: [],
    stream: '',
    state: 'idle',
    model: null,
    permissionMode: null,
    loaded: false,
    error: null,
    start: 0,
    loadingOlder: false,
    sig: '',
  };
}

function mergeItems(list: Item[], incoming: Item[]): Item[] {
  const out = list.slice();
  for (const item of incoming) {
    if (item.kind === 'tool_result') {
      const idx = out.findLastIndex((x) => x.kind === 'tool' && x.id === item.toolUseId);
      if (idx >= 0) {
        const tool = out[idx];
        if (tool.kind === 'tool') out[idx] = { ...tool, result: { text: item.text, isError: item.isError } };
      }
      continue;
    }
    if (!out.some((x) => x.id === item.id && x.kind === item.kind)) out.push(item);
  }
  return out;
}

class Bridge {
  private state: AppState = {
    ready: false,
    status: 'idle',
    error: null,
    address: '',
    host: null,
    home: null,
    sessions: [],
    sessionsLoaded: false,
    chats: {},
    permissions: [],
    usage: null,
    usageError: null,
    usageLoading: false,
    rateLimit: null,
    desktopApprovals: null,
    note: null,
    syncedAt: 0,
  };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private token = '';
  private reqId = 0;
  private waiting = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private wantConnection = false;
  private active: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** Answers given while the connection was down; sent as soon as it is back. */
  private unsent = new Map<string, Record<string, unknown>>();
  /** Requests answered here: they must not be shown again by a refresh or a reconnect. */
  private answered = new Set<string>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private patchChat(sessionId: string, fn: (c: ChatState) => ChatState) {
    const current = this.state.chats[sessionId] ?? emptyChat();
    this.set({ chats: { ...this.state.chats, [sessionId]: fn(current) } });
  }

  /** Load saved address + token and connect if both exist. */
  async init() {
    try {
      const [saved, token] = await Promise.all([AsyncStorage.getItem(ADDRESS_KEY), loadToken()]);
      const address = saved || (await defaultWebAddress());
      this.set({ ready: true, address: address ?? '' });
      if (address && token) this.connect(address, token);
    } catch {
      this.set({ ready: true });
    }
  }

  /** The session the user is looking at; it is refreshed in the background. */
  setActive(sessionId: string | null) {
    this.active = sessionId;
  }

  /**
   * Every few seconds, pick up changes made elsewhere (the desktop app, Telegram):
   * the session list, and the open session unless this service is running it,
   * in which case live events already keep it current.
   */
  private startRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.state.status !== 'connected') return;
      this.refreshSessions();
      const id = this.active;
      if (!id) return;
      const chat = this.state.chats[id];
      const session = this.state.sessions.find((s) => s.id === id);
      if (chat?.loaded && !chat.stream && !session?.live) this.openSession(id);
    }, REFRESH_MS);
  }

  connect(address: string, token: string) {
    const clean = address.trim().replace(/^(wss?|https?):\/\//, '').replace(/\/+$/, '');
    this.token = token.trim();
    this.wantConnection = true;
    this.attempts = 0;
    this.set({ address: clean, error: null });
    this.open('connecting');
    this.startRefresh();
  }

  disconnect(forget: boolean) {
    this.wantConnection = false;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    if (forget) {
      saveToken(null).catch(() => {});
      this.token = '';
    }
    this.set({
      status: 'idle',
      sessions: [],
      sessionsLoaded: false,
      chats: {},
      permissions: [],
      usage: null,
      host: null,
    });
  }

  private open(status: ConnStatus) {
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.set({ status });
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${this.state.address}`);
    } catch {
      this.wantConnection = false;
      this.set({ status: 'idle', error: 'That address is not valid. Use the form 192.168.1.10:8787.' });
      return;
    }
    this.ws = ws;
    let authed = false;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token }));
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'auth_ok') {
        authed = true;
        this.attempts = 0;
        // The service sends every request that is still waiting right after this
        // message, so start from an empty list: requests answered or cancelled
        // while this app was disconnected must not come back.
        this.set({ status: 'connected', error: null, host: m.host, home: m.home, permissions: [] });
        this.flushUnsent();
        AsyncStorage.setItem(ADDRESS_KEY, this.state.address).catch(() => {});
        saveToken(this.token).catch(() => {});
        // The waiting requests arrive right after auth_ok, before this reply: once
        // it is here, the list is complete and anything else shown is out of date.
        this.request({ type: 'list_sessions' })
          .then(() => this.set({ syncedAt: Date.now() }))
          .catch(() => {});
        this.refreshUsage();
        this.request({ type: 'get_desktop_approvals' }).catch(() => {});
        // Reload any chat that was open before a reconnect.
        for (const id of Object.keys(this.state.chats)) this.openSession(id);
        return;
      }
      if (m.type === 'auth_failed') {
        this.wantConnection = false;
        this.set({ status: 'idle', error: 'The token was not accepted. Check it against the bridge window.' });
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const w of this.waiting.values()) w.reject(new Error('Connection lost.'));
      this.waiting.clear();
      if (!this.wantConnection) return;
      if (!authed && this.state.status === 'connecting') {
        this.wantConnection = false;
        this.set({
          status: 'idle',
          error: 'Could not reach the bridge. Check the address, that the bridge is running, and that the phone is on the same network.',
        });
        return;
      }
      this.attempts += 1;
      this.set({ status: 'reconnecting' });
      this.retry = setTimeout(() => this.open('reconnecting'), Math.min(1000 * 2 ** this.attempts, 15000));
    };
    ws.onerror = () => {};
  }

  private request<T = any>(msg: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('Not connected to the bridge.'));
    const reqId = ++this.reqId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ ...msg, reqId }));
    });
  }

  private onMessage(m: any) {
    if (m.reqId && this.waiting.has(m.reqId)) {
      const w = this.waiting.get(m.reqId)!;
      this.waiting.delete(m.reqId);
      if (m.type === 'error') w.reject(new Error(m.message));
      else w.resolve(m);
      if (m.type !== 'sessions' && m.type !== 'desktop_approvals') return;
    }
    switch (m.type) {
      case 'sessions':
        this.set({ sessions: m.sessions, sessionsLoaded: true });
        break;
      case 'items':
        if (this.state.chats[m.sessionId]?.loaded) {
          this.patchChat(m.sessionId, (c) => ({ ...c, items: mergeItems(c.items, m.items) }));
        }
        break;
      case 'stream':
        if (this.state.chats[m.sessionId]?.loaded) {
          this.patchChat(m.sessionId, (c) => ({ ...c, stream: c.stream + m.text }));
        }
        break;
      case 'stream_end':
        if (this.state.chats[m.sessionId]?.stream) this.patchChat(m.sessionId, (c) => ({ ...c, stream: '' }));
        break;
      case 'state': {
        const state = m.state as SessionState;
        if (this.state.chats[m.sessionId]) this.patchChat(m.sessionId, (c) => ({ ...c, state }));
        this.set({
          sessions: this.state.sessions.map((s) => (s.id === m.sessionId ? { ...s, state } : s)),
        });
        break;
      }
      case 'session_meta':
        if (this.state.chats[m.sessionId]) {
          this.patchChat(m.sessionId, (c) => ({
            ...c,
            model: m.model ?? c.model,
            permissionMode: m.permissionMode ?? c.permissionMode,
          }));
        }
        break;
      case 'permission_request':
        if (!this.answered.has(m.requestId) && !this.state.permissions.some((p) => p.requestId === m.requestId)) {
          this.set({ permissions: [...this.state.permissions, m as PermissionRequest] });
        }
        break;
      case 'permission_resolved': {
        const was = this.state.permissions.find((p) => p.requestId === m.requestId);
        const patch: Partial<AppState> = { permissions: this.state.permissions.filter((p) => p.requestId !== m.requestId) };
        // Tell the user when a request they could see was settled elsewhere.
        const elsewhere = m.by === 'computer' || (m.by === 'remote' && m.via && m.via !== 'app');
        if (was && !this.answered.has(m.requestId) && elsewhere) {
          const title = this.state.sessions.find((s) => s.id === m.sessionId)?.title ?? 'Session';
          patch.note = { text: `${resolvedText(m)} · ${title}`, sessionId: m.sessionId, at: Date.now() };
        }
        this.set(patch);
        break;
      }
      case 'rate_limit':
        this.set({ rateLimit: m.info });
        break;
      case 'desktop_approvals':
        this.set({ desktopApprovals: !!m.enabled });
        break;
    }
  }

  // ------------------------------------------------------------ actions

  refreshSessions() {
    this.request({ type: 'list_sessions' }).catch(() => {});
  }

  async refreshUsage() {
    this.set({ usageLoading: true, usageError: null });
    try {
      const r = await this.request<{ usage: Usage }>({ type: 'get_usage' });
      this.set({ usage: r.usage, usageLoading: false });
    } catch (e: any) {
      this.set({ usageLoading: false, usageError: e.message });
    }
  }

  async openSession(sessionId: string) {
    if (!this.state.chats[sessionId]) this.patchChat(sessionId, (c) => c);
    try {
      const h = await this.request<any>({ type: 'open_session', sessionId, limit: PAGE });
      const page: Item[] = mergeItems([], h.items);
      const pageStart: number = typeof h.start === 'number' ? h.start : 0;
      const json = JSON.stringify(h.items);
      const sig = `${h.total}:${pageStart}:${json.length}:${json.slice(-80)}`;
      this.patchChat(sessionId, (c) => {
        const meta = {
          state: h.state as SessionState,
          model: h.model ?? c.model,
          permissionMode: h.permissionMode ?? c.permissionMode,
          loaded: true,
          error: null,
        };
        // Nothing new: keep the same items so the list does not re-render.
        if (c.loaded && c.sig === sig) return { ...c, ...meta };
        // Keep older messages the user already scrolled back to; replace the newest page.
        const older = c.loaded && c.start < pageStart ? c.items.slice(0, pageStart - c.start) : [];
        return { ...c, ...meta, items: [...older, ...page], start: older.length ? c.start : pageStart, sig };
      });
      const known = new Set(this.state.permissions.map((p) => p.requestId));
      const extra = (h.pending as PermissionRequest[]).filter((p) => !known.has(p.requestId) && !this.answered.has(p.requestId));
      if (extra.length) this.set({ permissions: [...this.state.permissions, ...extra] });
    } catch (e: any) {
      this.patchChat(sessionId, (c) => ({ ...c, loaded: true, error: e.message }));
    }
  }

  /** Load the page of messages before the oldest one shown. */
  async loadOlder(sessionId: string) {
    const c = this.state.chats[sessionId];
    if (!c?.loaded || c.start <= 0 || c.loadingOlder) return;
    this.patchChat(sessionId, (x) => ({ ...x, loadingOlder: true }));
    try {
      const r = await this.request<any>({ type: 'load_older', sessionId, before: c.start, limit: PAGE });
      this.patchChat(sessionId, (x) => {
        if (x.start !== c.start) return { ...x, loadingOlder: false }; // changed meanwhile
        const have = new Set(x.items.map((i) => `${i.kind}:${i.id}`));
        const older = (r.items as Item[]).filter((i) => !have.has(`${i.kind}:${i.id}`));
        return { ...x, items: [...older, ...x.items], start: r.start, loadingOlder: false };
      });
    } catch {
      this.patchChat(sessionId, (x) => ({ ...x, loadingOlder: false }));
    }
  }

  async newSession(cwd: string, prompt: string, permissionMode: PermissionMode): Promise<string> {
    const r = await this.request<{ sessionId: string }>({ type: 'new_session', cwd, prompt, permissionMode });
    this.patchChat(r.sessionId, (c) => ({
      ...c,
      loaded: true,
      state: 'running',
      permissionMode,
      items: c.items.length ? c.items : [{ kind: 'user', id: 'first:0', text: prompt }],
    }));
    this.openSession(r.sessionId);
    return r.sessionId;
  }

  async sendPrompt(sessionId: string, text: string) {
    try {
      await this.request({ type: 'send', sessionId, text });
      this.patchChat(sessionId, (c) => ({ ...c, error: null }));
    } catch (e: any) {
      this.patchChat(sessionId, (c) => ({ ...c, error: e.message }));
      throw e;
    }
  }

  answerPermission(
    requestId: string,
    behavior: 'allow' | 'allow_always' | 'deny',
    extra?: { message?: string; answers?: Record<string, string> },
  ) {
    const msg = { type: 'permission_response', requestId, behavior, ...extra };
    // Hide the card at once, so it cannot be answered twice.
    this.answered.add(requestId);
    this.set({ permissions: this.state.permissions.filter((p) => p.requestId !== requestId) });
    return this.request(msg).catch((e: any) => {
      // "Already answered" (from another device) needs nothing more. Any other
      // failure means the answer did not arrive: keep it and send it again when
      // the connection is back, instead of losing it.
      if (!/already answered/i.test(String(e?.message))) this.unsent.set(requestId, msg);
    });
  }

  private flushUnsent() {
    const list = [...this.unsent.values()];
    this.unsent.clear();
    for (const msg of list) this.request(msg).catch(() => {});
  }

  interrupt(sessionId: string) {
    return this.request({ type: 'interrupt', sessionId }).catch(() => {});
  }

  async setMode(sessionId: string, mode: PermissionMode) {
    try {
      await this.request({ type: 'set_mode', sessionId, mode });
    } catch (e: any) {
      this.patchChat(sessionId, (c) => ({ ...c, error: e.message }));
    }
  }

  rename(sessionId: string, title: string) {
    return this.request({ type: 'rename', sessionId, title });
  }
  setSection(sessionId: string, section: string | null) {
    return this.request({ type: 'set_section', sessionId, section });
  }
  archive(sessionId: string, archived: boolean) {
    return this.request({ type: 'archive', sessionId, archived });
  }
  async deleteSession(sessionId: string) {
    await this.request({ type: 'delete_session', sessionId });
    const chats = { ...this.state.chats };
    delete chats[sessionId];
    this.set({ chats });
  }
  clearNote() {
    this.set({ note: null });
  }
  setDesktopApprovals(enabled: boolean) {
    return this.request({ type: 'set_desktop_approvals', enabled }).catch(() => {});
  }
  listDirs(path: string | null) {
    return this.request<DirListing>({ type: 'list_dirs', path });
  }
}

/** One line saying how a request ended. */
function resolvedText(m: { by?: string; via?: string | null; outcome?: string }): string {
  const where = m.by === 'computer' ? ' on the computer' : m.via === 'telegram' ? ' in Telegram' : '';
  switch (m.outcome) {
    case 'allowed':
      return `✅ Allowed${where}`;
    case 'allowed_always':
      return `✅ Always allowed${where}`;
    case 'denied':
      return `❌ Denied${where}`;
    case 'answered':
      return `💬 Answered${where}`;
    default:
      return `☑️ Answered${where}`;
  }
}

export const bridge = new Bridge();

export function useApp(): AppState {
  return useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
}

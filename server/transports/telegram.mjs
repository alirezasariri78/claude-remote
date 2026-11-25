// Telegram transport: drive Claude sessions from a private chat with your bot.
//
// The bot only makes outbound requests (long polling), so nothing has to be
// opened on the network, and it can go out through an HTTP proxy.
//
// Settings (bridge-config.json -> "telegram"):
//   botToken        token from @BotFather
//   allowedUserIds  numeric Telegram user ids that may use the bot
//   proxy           optional, e.g. "http://127.0.0.1:8080" (default: HTTPS_PROXY)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, fetch as httpFetch } from 'undici';

// Request messages and their pending updates survive a restart of the service
// and a lost connection to Telegram (see "outbox" below).
const STATE_FILE = process.env.BRIDGE_TELEGRAM_STATE || fileURLToPath(new URL('../telegram-requests.json', import.meta.url));

const MAX_MESSAGE = 3900; // Telegram's limit is 4096 characters
const MODES = { default: 'Ask permissions', acceptEdits: 'Accept edits', plan: 'Plan mode' };

const HELP = `Claude Remote

/menu - main menu with buttons
/sessions - pick a session to continue
/sections - browse sessions by section
/section Name - move the selected session to a section (/section none removes it)
/new - start a session (choose a folder, then send the first message)
/new D:\\path\\to\\folder - start a session in that folder
/pending - show permission requests waiting for your answer
/current - show the selected session
/stop - interrupt Claude
/mode - change the permission mode
/usage - show plan usage limits
/id - show your Telegram user id

Any other message is sent to the selected session. Permission requests arrive with Allow / Deny buttons.`;

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function baseName(p) {
  if (!p) return 'No folder';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function toolSummary(input) {
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']) {
    if (typeof input?.[k] === 'string') return input[k].replace(/\s+/g, ' ');
  }
  return '';
}

function permissionDetail(p) {
  const i = p.input || {};
  if (typeof i.command === 'string') return i.command;
  if (typeof i.file_path === 'string') {
    const extra = typeof i.new_string === 'string' ? i.new_string : typeof i.content === 'string' ? i.content : '';
    return extra ? `${i.file_path}\n\n${extra}` : i.file_path;
  }
  if (typeof i.url === 'string') return i.url;
  if (typeof i.plan === 'string') return i.plan;
  const json = JSON.stringify(i, null, 2);
  return json === '{}' ? '' : json;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function resetText(iso) {
  const at = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(at)) return '';
  const min = Math.max(0, Math.round((at - Date.now()) / 60000));
  if (min < 60) return `, resets in ${min} min`;
  if (min < 24 * 60) return `, resets in ${Math.floor(min / 60)}h ${min % 60}m`;
  return `, resets in ${Math.round(min / 1440)} days`;
}

export function startTelegram(core, config) {
  const tg = { ...(config.telegram || {}) };
  if (process.env.BRIDGE_TELEGRAM_TOKEN) tg.botToken = process.env.BRIDGE_TELEGRAM_TOKEN;
  if (process.env.BRIDGE_TELEGRAM_USERS) tg.allowedUserIds = process.env.BRIDGE_TELEGRAM_USERS.split(',');
  if (process.env.BRIDGE_TELEGRAM_API) tg.apiBase = process.env.BRIDGE_TELEGRAM_API;

  if (process.env.BRIDGE_NO_TELEGRAM) tg.botToken = ''; // for local test runs next to the real service

  if (!tg.botToken) {
    console.log('Telegram bot: not configured (set telegram.botToken in bridge-config.json).\n');
    return { name: 'telegram', stop() {} };
  }

  const apiBase = (tg.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  const isLocalApi = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiBase + '/');
  const proxyUrl = tg.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const dispatcher = proxyUrl && !isLocalApi ? new ProxyAgent(proxyUrl) : undefined;
  const allowed = new Set((tg.allowedUserIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const abort = new AbortController();
  let stopped = false;

  /** chatId -> { sessionId, pendingNew, folders, mode, lastSent, typingAt, queue } */
  const chats = new Map();
  /** requestId -> [{ chatId, messageId, text, title }] so buttons can be removed once answered */
  const permissionMessages = new Map();
  /**
   * Changes Telegram has not received yet, kept until it does: when the service
   * cannot reach Telegram (offline, proxy down), they are sent once it can.
   *   { kind: 'edit', chatId, messageId, text }   replace a request's buttons with its result
   *   { kind: 'note', chatId, text, at }           "Allowed on the computer — session"
   */
  let outbox = [];

  function saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ open: [...permissionMessages], outbox }, null, 1));
    } catch (err) {
      console.error('Telegram: could not save its state:', err.message);
    }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    outbox = Array.isArray(saved.outbox) ? saved.outbox : [];
    // Requests still showing buttons from before a restart: they are no longer
    // waiting (a restart ends them), so their buttons go too.
    const waiting = new Set(core.pendingPermissions().map((p) => p.requestId));
    for (const [requestId, msgs] of Array.isArray(saved.open) ? saved.open : []) {
      if (waiting.has(requestId)) {
        permissionMessages.set(requestId, msgs);
        continue;
      }
      for (const m of msgs || []) {
        if (m?.chatId && m?.messageId) {
          outbox.push({ kind: 'edit', chatId: m.chatId, messageId: m.messageId, text: `${m.text || ''}\n\n☑️ No longer waiting` });
        }
      }
    }
  } catch {}
  const titles = new Map();

  const chatOf = (chatId) => {
    if (!chats.has(chatId)) {
      chats.set(chatId, { sessionId: null, pendingNew: null, awaiting: null, sections: null, folders: [], mode: 'default', lastSent: '', typingAt: 0, queue: Promise.resolve() });
    }
    return chats.get(chatId);
  };

  const safeError = (err) => String(err?.message || err).split(tg.botToken).join('<token>');

  async function api(method, body, timeoutMs = 25_000) {
    const res = await httpFetch(`${apiBase}/bot${tg.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      dispatcher,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(json.description || `Telegram ${method} failed`);
      err.fromTelegram = true; // Telegram answered and refused: retrying will not help
      throw err;
    }
    return json.result;
  }

  /** Like api(), but retries when the network or proxy drops the request. */
  async function apiRetry(method, body, attempts = 5) {
    for (let i = 1; ; i++) {
      try {
        return await api(method, body);
      } catch (err) {
        if (stopped || err?.fromTelegram || i >= attempts) throw err;
        await new Promise((r) => setTimeout(r, 1000 * i));
      }
    }
  }

  /** Send text in order per chat, split to Telegram's size limit. Returns the last message. */
  function send(chatId, text, replyMarkup) {
    const chat = chatOf(chatId);
    const run = async () => {
      const body = String(text || '').trim() || '(empty)';
      const parts = [];
      for (let rest = body; rest.length; ) {
        let cut = rest.length <= MAX_MESSAGE ? rest.length : rest.lastIndexOf('\n', MAX_MESSAGE);
        if (cut < MAX_MESSAGE / 2) cut = Math.min(rest.length, MAX_MESSAGE);
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
      }
      let last = null;
      for (let i = 0; i < parts.length; i++) {
        const payload = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
        if (replyMarkup && i === parts.length - 1) payload.reply_markup = replyMarkup;
        last = await apiRetry('sendMessage', payload);
      }
      return last;
    };
    const p = chat.queue.then(run, run);
    chat.queue = p.catch((err) => console.error('Telegram send failed:', safeError(err)));
    return p;
  }

  async function sessionTitle(sessionId) {
    if (!titles.has(sessionId)) await refreshTitles();
    return titles.get(sessionId) || 'Session';
  }

  async function refreshTitles() {
    const { sessions } = await core.request('list_sessions');
    for (const s of sessions) titles.set(s.id, s.title);
    return sessions;
  }

  // ------------------------------------------------------------ live events

  function renderItem(chat, item) {
    switch (item.kind) {
      case 'assistant':
        return item.text;
      case 'user':
        if (item.text === chat.lastSent) return null; // our own prompt
        return `From another device:\n${clip(item.text, 1000)}`;
      case 'tool':
        return `🔧 ${item.name}${toolSummary(item.input) ? `: ${clip(toolSummary(item.input), 300)}` : ''}`;
      case 'tool_result':
        return item.isError ? `❌ Tool failed:\n${clip(item.text, 800)}` : null;
      case 'result': {
        if (item.isError) return `❌ ${clip(item.text || 'The turn ended with an error.', 1500)}`;
        const parts = [];
        if (item.durationMs) parts.push(`${Math.round(item.durationMs / 1000)}s`);
        const u = item.usage;
        if (u) {
          const total =
            (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          if (total) parts.push(`${formatTokens(total)} tokens`);
        }
        if (typeof item.costUsd === 'number' && item.costUsd > 0) parts.push(`$${item.costUsd.toFixed(3)}`);
        return `✅ Done${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
      }
      default:
        return null;
    }
  }

  /**
   * Send a waiting request to every allowed user (or one chat), whatever screen
   * or session they are on. Returns true when at least one message was delivered.
   */
  async function announcePermission(p, onlyChatId, prefix = '') {
    const where = p.source === 'desktop' ? ' (on the PC)' : '';
    const title = (await sessionTitle(p.sessionId).catch(() => 'Session')) + where;
    const questions = p.toolName === 'AskUserQuestion' && Array.isArray(p.input?.questions) ? p.input.questions : null;
    let text;
    let keyboard;
    if (questions) {
      const simple = questions.length === 1 && !questions[0].multiSelect && (questions[0].options || []).length <= 8;
      text = `${prefix}❓ Claude has a question — ${title}\n\n${questions.map((q) => q.question).join('\n\n')}`;
      keyboard = simple
        ? questions[0].options.map((o, i) => [{ text: clip(o.label, 60), callback_data: `q:${i}:${p.requestId}` }])
        : [];
      if (!simple) text += '\n\nThis question has several parts. Answer it in the mobile app, or skip it.';
      keyboard.push([{ text: 'Skip', callback_data: `pd:${p.requestId}` }]);
    } else {
      const detail = permissionDetail(p);
      text = `${prefix}🔐 Permission needed — ${title}\n\n${p.title || `Claude wants to use ${p.displayName || p.toolName}`}`;
      if (p.description) text += `\n${p.description}`;
      if (detail) text += `\n\n${clip(detail, 1500)}`;
      const row = [
        { text: 'Deny', callback_data: `pd:${p.requestId}` },
        { text: 'Allow once', callback_data: `pa:${p.requestId}` },
      ];
      keyboard = p.canAlways ? [row, [{ text: 'Always allow', callback_data: `pA:${p.requestId}` }]] : [row];
    }
    let delivered = false;
    for (const chatId of onlyChatId ? [onlyChatId] : allowed) {
      try {
        const msg = await send(chatId, text, { inline_keyboard: keyboard });
        if (msg?.message_id) {
          delivered = true;
          if (!permissionMessages.has(p.requestId)) permissionMessages.set(p.requestId, []);
          permissionMessages.get(p.requestId).push({ chatId, messageId: msg.message_id, text, title });
          saveState();
        }
      } catch (err) {
        console.error('Telegram: could not deliver a permission request:', safeError(err));
      }
    }
    return delivered;
  }

  let flushing = false;
  /** Send what is in the outbox, oldest first; stop at the first network failure and keep the rest. */
  async function flushOutbox() {
    if (flushing || stopped || !outbox.length) return;
    flushing = true;
    try {
      while (outbox.length && !stopped) {
        const job = outbox[0];
        try {
          if (job.kind === 'edit') {
            await api('editMessageText', {
              chat_id: job.chatId,
              message_id: job.messageId,
              text: clip(job.text, MAX_MESSAGE),
              reply_markup: { inline_keyboard: [] },
              disable_web_page_preview: true,
            });
          } else if (job.kind === 'note') {
            const late = Date.now() - (job.at || 0) > 120_000;
            const when = late ? ` (at ${new Date(job.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})` : '';
            await api('sendMessage', { chat_id: job.chatId, text: job.text + when, disable_web_page_preview: true });
          }
        } catch (err) {
          if (!err?.fromTelegram) break; // offline: try again later
          // Telegram refused (message deleted, too old, unchanged): nothing more to do,
          // except removing the buttons when only the text could not be changed.
          if (job.kind === 'edit' && !/not found|can't be edited/i.test(String(err.message))) {
            await api('editMessageReplyMarkup', { chat_id: job.chatId, message_id: job.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
          }
        }
        outbox.shift();
        saveState();
      }
    } finally {
      flushing = false;
    }
  }
  const outboxTimer = setInterval(() => flushOutbox(), 20_000);

  /** One line saying how a request ended. */
  function resolvedStatus(ev) {
    const where =
      ev.by === 'computer' ? ' on the computer' : ev.via === 'telegram' ? ' in Telegram' : ev.via === 'app' ? ' in the app' : '';
    switch (ev.outcome) {
      case 'allowed': return `✅ Allowed${where}`;
      case 'allowed_always': return `✅ Always allowed${where}`;
      case 'denied': return `❌ Denied${where}`;
      case 'answered': return `💬 Answered${where}`;
      case 'answered_here': return '☑️ Answered on the computer';
      case 'expired': return '⌛ No answer in time — Claude now asks on the computer';
      case 'cancelled': return '⏹ Cancelled by Claude';
      default: return `☑️ Answered${where}`;
    }
  }

  const isPending = (requestId) => core.pendingPermissions().some((x) => x.requestId === requestId);

  /** A request must not be missed: keep trying to deliver it, then remind while it waits. */
  async function watchPermission(p) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let delivered = await announcePermission(p).catch(() => false);
    for (let i = 0; !delivered && i < 40; i++) {
      await wait(15_000);
      if (stopped || !isPending(p.requestId)) return;
      delivered = await announcePermission(p).catch(() => false);
    }
    // Reminders: after 3 minutes, then every 10 minutes, for up to about an hour.
    for (const delay of [180_000, 600_000, 600_000, 600_000, 600_000, 600_000]) {
      await wait(delay);
      if (stopped || !isPending(p.requestId)) return;
      await announcePermission(p, undefined, '⏰ Still waiting for your answer\n\n').catch(() => {});
    }
  }

  /** Show every waiting request to one chat again (from the menu or /pending). */
  async function showPending(chatId) {
    const waiting = core.pendingPermissions();
    if (!waiting.length) return send(chatId, 'Nothing is waiting for you.', { inline_keyboard: [[{ text: '« Menu', callback_data: 'M' }]] });
    for (const p of waiting) await announcePermission(p, chatId);
  }

  function onEvent(ev) {
    if (stopped) return;
    switch (ev.type) {
      case 'permission_request':
        watchPermission(ev).catch(() => {});
        break;
      case 'permission_resolved': {
        const sent = permissionMessages.get(ev.requestId) || [];
        permissionMessages.delete(ev.requestId);
        const status = resolvedStatus(ev);
        // Keep the request readable; replace its buttons with what happened.
        for (const m of sent) outbox.push({ kind: 'edit', chatId: m.chatId, messageId: m.messageId, text: `${m.text}\n\n${status}` });
        // Answered on the computer: also say so in a new message, so it is noticed.
        if (ev.by === 'computer') {
          for (const chatId of new Set(sent.map((m) => m.chatId))) {
            const title = sent.find((m) => m.chatId === chatId)?.title || 'Session';
            outbox.push({ kind: 'note', chatId, text: `${status} — ${title}`, at: Date.now() });
          }
        }
        saveState();
        flushOutbox();
        break;
      }
      case 'items':
        for (const [chatId, chat] of chats) {
          if (chat.sessionId !== ev.sessionId) continue;
          for (const item of ev.items) {
            const text = renderItem(chat, item);
            if (text) send(chatId, text).catch(() => {});
          }
        }
        break;
      case 'stream':
        for (const [chatId, chat] of chats) {
          if (chat.sessionId !== ev.sessionId || Date.now() - chat.typingAt < 4000) continue;
          chat.typingAt = Date.now();
          api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
        }
        break;
      case 'sessions':
        for (const s of ev.sessions) titles.set(s.id, s.title);
        break;
    }
  }

  // ------------------------------------------------------------ screens (inline buttons)
  // Every screen is one message with inline buttons. Tapping a button edits
  // that message in place, so the chat does not fill up with menus.

  const btn = (text, data) => ({ text, callback_data: data });
  const MENU_ROW = [btn('« Menu', 'M')];

  async function show(chatId, messageId, text, keyboard) {
    const markup = keyboard ? { inline_keyboard: keyboard } : undefined;
    if (messageId) {
      try {
        await api('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: clip(text, MAX_MESSAGE),
          reply_markup: markup,
          disable_web_page_preview: true,
        });
        return;
      } catch (err) {
        if (/not modified/i.test(String(err?.message))) return;
        // Message too old or gone: fall through and send a new one.
      }
    }
    return send(chatId, text, markup);
  }

  const sessionButton = (s) => {
    const icon = s.state === 'requires_action' ? '🔐 ' : s.state === 'running' ? '⏳ ' : '';
    return [btn(clip(`${icon}${s.title}`, 44) + ` · ${clip(baseName(s.cwd), 16)}`, `s:${s.id}`)];
  };

  async function showMenu(chatId, messageId) {
    const chat = chatOf(chatId);
    chat.awaiting = null;
    const title = chat.sessionId ? await sessionTitle(chat.sessionId).catch(() => null) : null;
    const text = `Claude Remote\n\nSelected session: ${title || 'none'}\nPermission mode: ${MODES[chat.mode] || chat.mode}`;
    const keyboard = [
      [btn('💬 Sessions', 'L'), btn('🗂 Sections', 'S')],
      [btn('➕ New session', 'N'), btn('📊 Usage', 'U')],
      [btn('🛡 Permission mode', 'O')],
    ];
    if (chat.sessionId) keyboard.push([btn('⚙️ Selected session', 'C')]);
    const approvals = await core.request('get_desktop_approvals').catch(() => null);
    if (approvals) keyboard.push([btn(`🖥 PC session approvals: ${approvals.enabled ? 'On' : 'Off'}`, 'H')]);
    const waiting = core.pendingPermissions().length;
    if (waiting) keyboard.unshift([btn(`🔐 Waiting for you (${waiting})`, 'P')]);
    return show(chatId, messageId, waiting ? `${text}

🔐 ${waiting} request${waiting > 1 ? 's are' : ' is'} waiting for your answer.` : text, keyboard);
  }

  async function showSessions(chatId, messageId) {
    const sessions = (await refreshTitles()).filter((s) => !s.archived).slice(0, 12);
    const keyboard = [...sessions.map(sessionButton), [btn('➕ New session', 'N')], MENU_ROW];
    const waiting = core.pendingPermissions().length;
    if (waiting) keyboard.unshift([btn(`🔐 Waiting for you (${waiting})`, 'P')]);
    return show(chatId, messageId, sessions.length ? 'Recent sessions:' : 'No sessions yet.', keyboard);
  }

  /** Sections are labels on sessions. List them, or the sessions inside one. */
  async function showSections(chatId, messageId, index) {
    const chat = chatOf(chatId);
    const sessions = (await refreshTitles()).filter((s) => !s.archived);
    if (index === undefined) {
      const names = [...new Set(sessions.map((s) => s.section).filter(Boolean))].sort();
      chat.sections = [...names, null]; // null = sessions without a section
      const count = (name) => sessions.filter((s) => (s.section || null) === name).length;
      if (!names.length) {
        return show(chatId, messageId, 'No sections yet.\nOpen a session and tap "Move to section" to create one.', [
          [btn('💬 Sessions', 'L')],
          MENU_ROW,
        ]);
      }
      const keyboard = chat.sections
        .filter((name) => count(name) > 0)
        .map((name) => [btn(`${name === null ? 'No section' : `🗂 ${name}`} (${count(name)})`, `S:${chat.sections.indexOf(name)}`)]);
      keyboard.push(MENU_ROW);
      return show(chatId, messageId, 'Sections:', keyboard);
    }
    if (!chat.sections || index >= chat.sections.length) return showSections(chatId, messageId);
    const name = chat.sections[index];
    const inside = sessions.filter((s) => (s.section || null) === name).slice(0, 20);
    return show(chatId, messageId, inside.length ? `${name ?? 'No section'}:` : 'That section is empty now.', [
      ...inside.map(sessionButton),
      [btn('« Sections', 'S'), btn('« Menu', 'M')],
    ]);
  }

  /** The selected session with its action buttons. Pass sessionId to select it first. */
  async function showSession(chatId, messageId, sessionId, note) {
    const chat = chatOf(chatId);
    chat.awaiting = null;
    const id = sessionId || chat.sessionId;
    if (!id) return showSessions(chatId, messageId);
    const h = await core.request('open_session', { sessionId: id });
    chat.sessionId = id;
    chat.pendingNew = null;
    if (h.permissionMode) chat.mode = h.permissionMode;
    const info = (await refreshTitles()).find((s) => s.id === id);
    const last = h.items.findLast((i) => i.kind === 'assistant');
    let text = `💬 ${info?.title || 'Session'}\n`;
    text += `Folder: ${baseName(info?.cwd)}  ·  Section: ${info?.section || 'none'}${info?.archived ? '  ·  Archived' : ''}`;
    if (h.state === 'running') text += '\n⏳ Claude is working on it now.';
    if (note) text += `\n\n${note}`;
    if (last) text += `\n\nLast reply:\n${clip(last.text, 1200)}`;
    text += '\n\nSend a message to continue.';
    await show(chatId, messageId, text, [
      [btn('🗂 Move to section', 'T'), btn('✏️ Rename', 'R')],
      [btn(info?.archived ? '📤 Unarchive' : '📦 Archive', 'A'), btn('⏹ Stop', 'X')],
      [btn('🛡 Permission mode', 'O'), btn('🗑 Delete', 'D')],
      [btn('« Sessions', 'L'), btn('« Menu', 'M')],
    ]);
    for (const p of h.pending || []) if (!permissionMessages.has(p.requestId)) await announcePermission(p);
  }

  async function showMoveMenu(chatId, messageId) {
    const chat = chatOf(chatId);
    if (!chat.sessionId) return showSessions(chatId, messageId);
    const sessions = await refreshTitles();
    const current = sessions.find((s) => s.id === chat.sessionId)?.section || null;
    const names = [...new Set(sessions.map((s) => s.section).filter(Boolean))].sort();
    chat.sections = [...names, null];
    const keyboard = names.map((n, i) => [btn(n === current ? `🗂 ${n} ✓` : `🗂 ${n}`, `T:${i}`)]);
    keyboard.push([btn('➕ New section', 'Tn')]);
    if (current) keyboard.push([btn('Remove from section', `T:${names.length}`)]);
    keyboard.push([btn('« Back', 'C')]);
    return show(chatId, messageId, `Move "${clip(await sessionTitle(chat.sessionId), 80)}" to a section.\nCurrent: ${current || 'none'}`, keyboard);
  }

  async function setSection(chatId, messageId, name) {
    const chat = chatOf(chatId);
    if (!chat.sessionId) return send(chatId, 'Select a session first.');
    await core.request('set_section', { sessionId: chat.sessionId, section: name });
    return showSession(chatId, messageId, null, name ? `Moved to section ${name}.` : 'Removed from its section.');
  }

  async function showFolders(chatId, messageId) {
    const chat = chatOf(chatId);
    const sessions = await refreshTitles();
    chat.folders = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].slice(0, 8);
    const keyboard = chat.folders.map((f, i) => [btn(`📁 ${clip(baseName(f), 28)}  (${clip(f, 26)})`, `f:${i}`)]);
    keyboard.push(MENU_ROW);
    return show(chatId, messageId, 'New session: choose a folder.\nFor another folder, send:\n/new D:\\path\\to\\folder', keyboard);
  }

  async function showUsage(chatId, messageId) {
    const { usage } = await core.request('get_usage');
    let text;
    if (!usage.rateLimitsAvailable || !usage.rateLimits) {
      text = "Plan limits are not available for this computer's sign-in.";
    } else {
      const rl = usage.rateLimits;
      const line = (label, w) =>
        w && typeof w.utilization === 'number' ? `${label}: ${Math.round(w.utilization)}% used${resetText(w.resets_at)}` : null;
      text =
        [
          usage.subscriptionType ? `Plan: ${usage.subscriptionType}` : null,
          line('5-hour session', rl.five_hour),
          line('Weekly, all models', rl.seven_day),
          ...(rl.model_scoped || []).map((m) => line(`Weekly, ${m.display_name}`, m)),
        ]
          .filter(Boolean)
          .join('\n') || 'No usage data.';
    }
    return show(chatId, messageId, `📊 Usage limits\n\n${text}`, [[btn('🔄 Refresh', 'U')], MENU_ROW]);
  }

  async function showModes(chatId, messageId) {
    const chat = chatOf(chatId);
    const keyboard = Object.entries(MODES).map(([k, label]) => [btn(k === chat.mode ? `${label} ✓` : label, `m:${k}`)]);
    keyboard.push([btn('« Back', chat.sessionId ? 'C' : 'M')]);
    return show(
      chatId,
      messageId,
      'Permission mode\n\nAsk permissions: Claude asks before edits and commands.\nAccept edits: file edits are approved automatically.\nPlan mode: Claude only proposes a plan.',
      keyboard,
    );
  }

  async function startNewIn(chatId, messageId, cwd) {
    const chat = chatOf(chatId);
    chat.awaiting = null;
    chat.pendingNew = { cwd };
    return show(chatId, messageId, `New session in:\n${cwd}\n\nSend the first message now.`, [[btn('Cancel', 'M')]]);
  }

  // ------------------------------------------------------------ input

  async function onText(chatId, text) {
    const chat = chatOf(chatId);
    const cmdRaw = text.trim().split(/\s+/)[0];
    const isCommand = cmdRaw.startsWith('/');
    const cmd = isCommand ? cmdRaw.slice(1).split('@')[0].toLowerCase() : '';
    const rest = isCommand ? text.trim().slice(cmdRaw.length).trim() : '';

    if (isCommand) {
      chat.awaiting = null;
      switch (cmd) {
        case 'start':
        case 'menu':
          return showMenu(chatId);
        case 'help':
          return send(chatId, HELP, { inline_keyboard: [MENU_ROW] });
        case 'id':
          return send(chatId, `Your Telegram user id is ${chatId}.`);
        case 'sessions':
          return showSessions(chatId);
        case 'sections':
          return showSections(chatId);
        case 'section':
          if (!rest) return showMoveMenu(chatId);
          return setSection(chatId, undefined, /^(none|remove|-)$/i.test(rest) ? null : clip(rest, 40));
        case 'new':
          return rest ? startNewIn(chatId, undefined, rest) : showFolders(chatId);
        case 'current':
          return showSession(chatId);
        case 'stop':
          if (!chat.sessionId) return send(chatId, 'No session selected.');
          await core.request('interrupt', { sessionId: chat.sessionId });
          return send(chatId, 'Asked Claude to stop.');
        case 'mode':
          return showModes(chatId);
        case 'usage':
          return showUsage(chatId);
        case 'pending':
          return showPending(chatId);
        default:
          return send(chatId, 'Unknown command.', { inline_keyboard: [MENU_ROW] });
      }
    }

    // A button asked for a typed value (new section name, new title).
    if (chat.awaiting && chat.sessionId) {
      const what = chat.awaiting;
      chat.awaiting = null;
      if (what === 'section') return setSection(chatId, undefined, clip(text.trim(), 40));
      if (what === 'rename') {
        await core.request('rename', { sessionId: chat.sessionId, title: clip(text.trim(), 120) });
        titles.set(chat.sessionId, clip(text.trim(), 120));
        return showSession(chatId, undefined, null, 'Renamed.');
      }
    }

    if (chat.pendingNew) {
      const { cwd } = chat.pendingNew;
      chat.lastSent = text;
      const r = await core.request('new_session', { cwd, prompt: text, permissionMode: chat.mode });
      chat.pendingNew = null;
      chat.sessionId = r.sessionId;
      return send(chatId, `Started a session in ${baseName(r.cwd)}.`);
    }
    if (!chat.sessionId) {
      return send(chatId, 'No session selected.', { inline_keyboard: [[btn('💬 Sessions', 'L'), btn('➕ New session', 'N')]] });
    }
    chat.lastSent = text;
    await core.request('send', { sessionId: chat.sessionId, text });
  }

  async function onCallback(chatId, data, messageId) {
    const chat = chatOf(chatId);
    const [kind, ...parts] = String(data || '').split(':');
    const arg = parts.join(':');
    const hasArg = parts.length > 0;
    switch (kind) {
      case 'M':
        chat.pendingNew = null;
        return showMenu(chatId, messageId);
      case 'L':
        return showSessions(chatId, messageId);
      case 'P':
        return showPending(chatId);
      case 'H': {
        // Prompts from sessions running in the desktop app / terminal on the PC.
        const cur = await core.request('get_desktop_approvals');
        await core.request('set_desktop_approvals', { enabled: !cur.enabled });
        return showMenu(chatId, messageId);
      }
      case 'S':
        return showSections(chatId, messageId, hasArg ? Number(arg) : undefined);
      case 's':
        return showSession(chatId, messageId, arg);
      case 'C':
        return showSession(chatId, messageId);
      case 'N':
        return showFolders(chatId, messageId);
      case 'U':
        return showUsage(chatId, messageId);
      case 'O':
        return showModes(chatId, messageId);
      case 'T':
        if (!hasArg) return showMoveMenu(chatId, messageId);
        if (!chat.sections || Number(arg) >= chat.sections.length) return showMoveMenu(chatId, messageId);
        return setSection(chatId, messageId, chat.sections[Number(arg)]);
      case 'Tn':
        if (!chat.sessionId) return showSessions(chatId, messageId);
        chat.awaiting = 'section';
        return show(chatId, messageId, 'Send the name of the new section.', [[btn('Cancel', 'C')]]);
      case 'R':
        if (!chat.sessionId) return showSessions(chatId, messageId);
        chat.awaiting = 'rename';
        return show(chatId, messageId, 'Send the new title for this session.', [[btn('Cancel', 'C')]]);
      case 'A': {
        if (!chat.sessionId) return showSessions(chatId, messageId);
        const info = (await refreshTitles()).find((s) => s.id === chat.sessionId);
        await core.request('archive', { sessionId: chat.sessionId, archived: !info?.archived });
        return showSession(chatId, messageId, null, info?.archived ? 'Unarchived.' : 'Archived.');
      }
      case 'X':
        if (!chat.sessionId) return;
        await core.request('interrupt', { sessionId: chat.sessionId });
        return send(chatId, 'Asked Claude to stop.');
      case 'D':
        if (!chat.sessionId) return showSessions(chatId, messageId);
        return show(
          chatId,
          messageId,
          `Delete "${clip(await sessionTitle(chat.sessionId), 80)}"?\n\nThis permanently removes the session and its history from the computer. It cannot be undone.`,
          [[btn('Cancel', 'C'), btn('🗑 Delete permanently', 'Dy')]],
        );
      case 'Dy': {
        if (!chat.sessionId) return showSessions(chatId, messageId);
        const id = chat.sessionId;
        await core.request('delete_session', { sessionId: id });
        chat.sessionId = null;
        titles.delete(id);
        return showSessions(chatId, messageId);
      }
      case 'f': {
        const cwd = chat.folders[Number(arg)];
        if (!cwd) return showFolders(chatId, messageId);
        return startNewIn(chatId, messageId, cwd);
      }
      case 'm':
        if (!MODES[arg]) return;
        chat.mode = arg;
        if (chat.sessionId) await core.request('set_mode', { sessionId: chat.sessionId, mode: arg });
        return showModes(chatId, messageId);
      case 'pa':
        return core.request('permission_response', { requestId: arg, behavior: 'allow', via: 'telegram' });
      case 'pA':
        return core.request('permission_response', { requestId: arg, behavior: 'allow_always', via: 'telegram' });
      case 'pd':
        return core.request('permission_response', { requestId: arg, behavior: 'deny', via: 'telegram' });
      case 'q': {
        const [index, ...idParts] = parts;
        const requestId = idParts.join(':');
        const pending = core.pendingPermissions().find((p) => p.requestId === requestId);
        const q = pending?.input?.questions?.[0];
        const option = q?.options?.[Number(index)];
        if (!option) throw new Error('That request was already answered.');
        return core.request('permission_response', { requestId, behavior: 'allow', answers: { [q.question]: option.label }, via: 'telegram' });
      }
    }
  }

  async function handleUpdate(update) {
    const msg = update.message;
    const cb = update.callback_query;
    const from = msg?.from || cb?.from;
    const chat = msg?.chat || cb?.message?.chat;
    if (!from || !chat) return;
    if (cb) api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    if (chat.type !== 'private') return; // never act in groups or channels

    if (!allowed.has(Number(from.id))) {
      await send(
        chat.id,
        `This bot is private.\nYour Telegram user id is ${from.id}. If this is your bot, add that number to telegram.allowedUserIds in bridge-config.json on the computer and restart the service.`,
      );
      return;
    }
    try {
      if (cb) await onCallback(chat.id, cb.data, cb.message?.message_id);
      else if (typeof msg.text === 'string') await onText(chat.id, msg.text);
      else await send(chat.id, 'Only text messages are supported.');
    } catch (err) {
      await send(chat.id, `⚠️ ${safeError(err)}`).catch(() => {});
    }
  }

  // ------------------------------------------------------------ polling

  async function poll() {
    let offset = 0;
    let failures = 0;
    try {
      const me = await api('getMe');
      console.log(`Telegram bot @${me.username} is ready${dispatcher ? ' (through the proxy)' : ''}.`);
      if (!allowed.size) {
        console.log('  No allowed users yet: message the bot, then add the id it shows to telegram.allowedUserIds.');
      }
      console.log('');
      api('setMyCommands', {
        commands: [
          { command: 'menu', description: 'Main menu' },
          { command: 'pending', description: 'Requests waiting for your answer' },
          { command: 'sessions', description: 'Pick a session' },
          { command: 'sections', description: 'Browse by section' },
          { command: 'section', description: 'Move selected session to a section' },
          { command: 'new', description: 'Start a session' },
          { command: 'current', description: 'Show the selected session' },
          { command: 'stop', description: 'Interrupt Claude' },
          { command: 'mode', description: 'Permission mode' },
          { command: 'usage', description: 'Usage limits' },
          { command: 'help', description: 'Help' },
        ],
      }).catch(() => {});
    } catch (err) {
      console.error('Telegram bot could not start:', safeError(err), '(will keep retrying)');
    }
    while (!stopped) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
        failures = 0;
        if (outbox.length) flushOutbox(); // connection is back: deliver what waited
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          handleUpdate(u).catch((err) => console.error('Telegram update failed:', safeError(err)));
        }
      } catch (err) {
        if (stopped) break;
        failures += 1;
        if (failures === 1 || failures % 20 === 0) console.error('Telegram connection problem:', safeError(err));
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))));
      }
    }
  }

  const unsubscribe = core.subscribe(onEvent);
  for (const id of allowed) chatOf(id);
  poll();

  return {
    name: 'telegram',
    stop() {
      stopped = true;
      clearInterval(outboxTimer);
      unsubscribe();
      abort.abort();
    },
  };
}

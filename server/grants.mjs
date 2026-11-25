// What the user already granted to each session: its permission mode and its
// "Always allow" rules.
//
// Claude keeps these only inside the running process. This service closes an
// idle process after a while and resumes the session on the next message; without
// this file the resumed session would start from zero and ask for everything
// again. Stored in session-grants.json next to the config.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE =
  process.env.BRIDGE_GRANTS_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-grants.json');
const MAX_SESSIONS = 500;
const MODES = ['default', 'acceptEdits', 'plan'];

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    const ids = Object.keys(cache);
    // Keep the file bounded: drop the sessions touched longest ago.
    if (ids.length > MAX_SESSIONS) {
      ids.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete cache[id];
    }
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error(`Could not save ${FILE}: ${err.message}`);
  }
}

function entry(sessionId) {
  const all = load();
  if (!all[sessionId]) all[sessionId] = { mode: null, rules: [], dirs: [] };
  all[sessionId].at = Date.now();
  return all[sessionId];
}

/** { mode, rules, dirs } for a session; empty values when nothing was granted. */
export function grantsFor(sessionId) {
  const g = load()[sessionId];
  return {
    mode: g && MODES.includes(g.mode) ? g.mode : null,
    rules: Array.isArray(g?.rules) ? g.rules.filter((r) => typeof r === 'string') : [],
    dirs: Array.isArray(g?.dirs) ? g.dirs.filter((d) => typeof d === 'string') : [],
  };
}

export function rememberMode(sessionId, mode) {
  if (!MODES.includes(mode)) return;
  const g = entry(sessionId);
  if (g.mode === mode) return;
  g.mode = mode;
  save();
}

/**
 * Remember the parts of an accepted "Always allow" that live only in the running
 * process (destination "session"). Rules written to a settings file are already
 * kept by Claude itself.
 */
export function rememberUpdates(sessionId, updates) {
  if (!Array.isArray(updates)) return;
  const g = entry(sessionId);
  let changed = false;
  for (const u of updates) {
    if (!u || u.destination !== 'session') continue;
    if (u.type === 'addRules' && u.behavior === 'allow' && Array.isArray(u.rules)) {
      for (const r of u.rules) {
        if (!r?.toolName) continue;
        const rule = r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
        if (!g.rules.includes(rule)) {
          g.rules.push(rule);
          changed = true;
        }
      }
    } else if (u.type === 'setMode' && MODES.includes(u.mode)) {
      if (g.mode !== u.mode) {
        g.mode = u.mode;
        changed = true;
      }
    } else if (u.type === 'addDirectories' && Array.isArray(u.directories)) {
      for (const d of u.directories) {
        if (typeof d === 'string' && !g.dirs.includes(d)) {
          g.dirs.push(d);
          changed = true;
        }
      }
    }
  }
  if (changed) save();
}

export function forgetGrants(sessionId) {
  const all = load();
  if (!all[sessionId]) return;
  delete all[sessionId];
  save();
}

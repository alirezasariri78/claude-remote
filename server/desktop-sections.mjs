// Read-only view of the Claude desktop app's sidebar sections ("groups").
// The app keeps them in its own config file, not in the session files, so we
// read that file and map each desktop session to its Claude Code session id.
// This is an internal, undocumented format: if the app changes it, this
// quietly returns nothing and the service keeps working.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cache = { at: 0, map: new Map() };

function dataDirs() {
  if (process.env.BRIDGE_DESKTOP_DATA) return [process.env.BRIDGE_DESKTOP_DATA];
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const bases =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Claude')]
      : process.platform === 'win32'
        ? [path.join(local, 'Claude-Data'), path.join(process.env.APPDATA || '', 'Claude')]
        : [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude')];
  const dirs = [];
  for (const base of bases) {
    try {
      if (fs.existsSync(path.join(base, 'claude_desktop_config.json'))) dirs.push(base);
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        const p = path.join(base, d.name);
        if (d.isDirectory() && fs.existsSync(path.join(p, 'claude_desktop_config.json'))) dirs.push(p);
      }
    } catch {}
  }
  return dirs;
}

/** Map of Claude Code session id -> desktop section name. Cached for 15 seconds. */
export function desktopSections() {
  if (Date.now() - cache.at < 15_000) return cache.map;
  const map = new Map();
  for (const dir of dataDirs()) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'claude_desktop_config.json'), 'utf8'));
      const scopes = cfg?.preferences?.epitaxyPrefs?.['dframe-group-scopes'] || {};
      for (const [scope, data] of Object.entries(scopes)) {
        const names = new Map((data.groups || []).map((g) => [g.id, g.name]));
        for (const [key, groupId] of Object.entries(data.assignments || {})) {
          const name = names.get(groupId);
          const localId = key.replace(/^code:/, '');
          if (!name || !/^local_[\w-]+$/.test(localId)) continue;
          try {
            const file = path.join(dir, 'claude-code-sessions', ...scope.split('/'), `${localId}.json`);
            const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const id of [meta.cliSessionId, meta.lastAssistantCliSessionId]) if (id) map.set(id, name);
          } catch {}
        }
      }
    } catch {}
  }
  cache = { at: Date.now(), map };
  return map;
}

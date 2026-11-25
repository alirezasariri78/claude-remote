// Adds or removes the Claude Remote permission hook in your Claude Code settings
// (%USERPROFILE%\.claude\settings.json). Run as your own Windows user:
//   node hook/install.mjs install
//   node hook/install.mjs uninstall
// Other settings and hooks in the file are left as they are. A one-time backup
// is written next to it as settings.json.claude-remote-backup.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';

const action = process.argv[2];
if (!['install', 'uninstall'].includes(action)) {
  console.log('Usage: node hook/install.mjs install | uninstall');
  process.exit(1);
}

const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'permission-hook.mjs').replace(/\\/g, '/');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const MARK = 'permission-hook.mjs';

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    console.log(`Could not read ${settingsPath} (${err.message}). Fix that file first; nothing was changed.`);
    process.exit(1);
  }
  const backup = `${settingsPath}.claude-remote-backup`;
  if (!fs.existsSync(backup)) fs.copyFileSync(settingsPath, backup);
} else {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
}

const isOurs = (group) => (group.hooks || []).some((h) => String(h.command || '').includes(MARK));
const hooks = (settings.hooks ??= {});
const others = (hooks.PermissionRequest || []).filter((group) => !isOurs(group));

if (action === 'install') {
  const wait = Number(loadConfig().desktopApprovals?.waitSeconds) || 300;
  hooks.PermissionRequest = [
    ...others,
    { matcher: '*', hooks: [{ type: 'command', command: `node "${hookScript}"`, timeout: wait + 30 }] },
  ];
} else if (others.length) {
  hooks.PermissionRequest = others;
} else {
  delete hooks.PermissionRequest;
  if (!Object.keys(hooks).length) delete settings.hooks;
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(
  action === 'install'
    ? `Hook installed in ${settingsPath}.\nNew Claude sessions on this computer will send permission prompts to Claude Remote.\nSessions that are already open pick it up after they are restarted.`
    : `Hook removed from ${settingsPath}.`,
);

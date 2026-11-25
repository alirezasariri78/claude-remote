// Settings for the service, stored next to the code in bridge-config.json.
// The access token is generated on first run.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(SERVER_DIR, 'bridge-config.json');

export function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  let changed = false;
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    changed = true;
  }
  if (!cfg.port) {
    cfg.port = 8787;
    changed = true;
  }
  if (!cfg.host) {
    cfg.host = '0.0.0.0';
    changed = true;
  }
  if (cfg.proxy === undefined) {
    // HTTP proxy the service and Claude use to reach the internet, e.g. http://127.0.0.1:8080
    cfg.proxy = cfg.telegram?.proxy || '';
    changed = true;
  }
  if (cfg.desktopApprovals === undefined) {
    // Forward permission prompts from the desktop app / terminal sessions to the clients
    // (needs the hook: node hook/install.mjs install). waitSeconds = how long to wait for a remote answer.
    cfg.desktopApprovals = { enabled: true, waitSeconds: 300 };
    changed = true;
  }
  if (!cfg.telegram) {
    // Fill in botToken (from @BotFather) and your numeric Telegram user id to enable the bot.
    cfg.telegram = { botToken: '', allowedUserIds: [], proxy: '' };
    changed = true;
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return {
    ...cfg,
    token: process.env.BRIDGE_TOKEN || cfg.token,
    port: Number(process.env.BRIDGE_PORT || cfg.port),
    host: process.env.BRIDGE_HOST || cfg.host,
  };
}

/** Save one top-level setting without touching the rest of the file. */
export function saveSetting(key, value) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg[key] = value;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

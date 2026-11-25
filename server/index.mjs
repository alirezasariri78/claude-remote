// Claude Remote service entry point.
// Starts the core hub and every client transport. Run directly (`npm start`)
// or as a Windows service (`npm run service:install`).

import { loadConfig, saveSetting } from './config.mjs';
import { core } from './core.mjs';
import { startWebSocket } from './transports/websocket.mjs';
import { startTelegram } from './transports/telegram.mjs';

const config = loadConfig();

// A Windows service does not get the terminal's proxy settings, so apply the
// configured proxy here; Claude's own process inherits it.
const proxy = config.proxy || config.telegram?.proxy;
if (proxy && !process.env.HTTPS_PROXY) {
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = proxy;
  process.env.NO_PROXY = process.env.NO_PROXY || 'localhost,127.0.0.1,::1';
  console.log('Using proxy ' + proxy + ' for Claude and Telegram.');
}

core.configureDesktopApprovals({
  enabled: config.desktopApprovals?.enabled !== false,
  waitSeconds: config.desktopApprovals?.waitSeconds,
  save: (enabled) => saveSetting('desktopApprovals', { ...config.desktopApprovals, enabled }),
});

// Each transport is a function (core, config) -> { name, stop() }.
// To add a client type later (for example a Telegram bot), write
// transports/telegram.mjs with the same shape and list it here: it calls
// core.request(...) for commands and core.subscribe(...) for live events.
const transportFactories = [startWebSocket, startTelegram];

console.log(`Claude Remote service is starting${core.demo ? ' in DEMO mode (simulated replies)' : ''}.\n`);
const transports = transportFactories.map((start) => start(core, config));

console.log('Anyone with the address and token can run commands on this computer.');
console.log('Keep it on a private network (home Wi-Fi or Tailscale).\n');

function shutdown() {
  for (const t of transports) {
    try {
      t.stop();
    } catch {}
  }
  core.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (m) => {
  if (m === 'shutdown') shutdown(); // sent by the Windows service wrapper
});

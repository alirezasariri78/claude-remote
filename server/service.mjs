// Install or remove Claude Remote as a Windows service.
//   node service.mjs install     (run from an Administrator terminal)
//   node service.mjs uninstall
//
// The service must log on as YOUR Windows account, not the default Local
// System account: Claude's sign-in and session history live in your user
// profile. This script does not ask for your password; you set the account
// once in the Services window, where Windows stores it securely.

import path from 'node:path';
import { createRequire } from 'node:module';
import { SERVER_DIR, CONFIG_PATH, loadConfig } from './config.mjs';

const require = createRequire(import.meta.url);
const { Service } = require('node-windows');

const action = process.argv[2];
if (process.platform !== 'win32' || !['install', 'uninstall'].includes(action)) {
  console.log('Usage (Windows, Administrator terminal): node service.mjs install | uninstall');
  process.exit(1);
}

const script = path.join(SERVER_DIR, 'index.mjs');
if (script.length > 180) {
  console.log(`This folder's path is too long for a Windows service:\n  ${SERVER_DIR}\nMove the project to a short path such as C:\\claude-remote and run this again.`);
  process.exit(1);
}

const svc = new Service({
  name: 'Claude Remote',
  description: 'Lets your own apps (mobile app, bots) drive Claude Code sessions on this computer.',
  script,
  workingDirectory: SERVER_DIR,
  nodeOptions: '--no-warnings',
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

svc.on('error', (err) => {
  console.error('Service error:', err?.message || err);
  console.error('If this is an access error, open the terminal with "Run as administrator".');
});

if (action === 'install') {
  loadConfig(); // creates bridge-config.json with the access token
  svc.on('alreadyinstalled', () => console.log('The service is already installed. Run "uninstall" first to reinstall.'));
  svc.on('install', () => {
    console.log(`Installed the "Claude Remote" service (not started yet).

Finish setup once:
  1. Press Win+R, type services.msc, press Enter.
  2. Open "Claude Remote" > Log On tab > "This account".
  3. Enter your Windows account and password, then OK.
  4. Right-click "Claude Remote" > Start.

It then starts automatically with Windows.
Address and token for the mobile app: see ${CONFIG_PATH}
Logs: ${path.join(SERVER_DIR, 'daemon')}`);
  });
  svc.install();
} else {
  svc.on('uninstall', () => console.log('The "Claude Remote" service was removed.'));
  svc.on('alreadyuninstalled', () => console.log('The service is not installed.'));
  svc.uninstall();
}

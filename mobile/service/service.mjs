// Install or remove the Claude Remote web app as a Windows service.
//   node service.mjs install     (run from an Administrator terminal)
//   node service.mjs uninstall
// This service only serves static files, so the default Local System account is fine.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Service } = require('node-windows');

const action = process.argv[2];
if (process.platform !== 'win32' || !['install', 'uninstall'].includes(action)) {
  console.log('Usage (Windows, Administrator terminal): node service.mjs install | uninstall');
  process.exit(1);
}

const svc = new Service({
  name: 'Claude Remote Web',
  description: 'Serves the Claude Remote app as a website on the local network.',
  script: path.join(DIR, 'index.mjs'),
  workingDirectory: DIR,
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
  if (!fs.existsSync(path.join(DIR, '..', 'dist', 'index.html'))) {
    console.log('Build the app first: in the mobile folder run  npm run build:web');
    process.exit(1);
  }
  svc.on('alreadyinstalled', () => console.log('The service is already installed. Run "uninstall" first to reinstall.'));
  svc.on('install', () => {
    svc.start();
    console.log(`Installed and started the "Claude Remote Web" service.
It starts automatically with Windows.
Settings: ${path.join(DIR, 'web-config.json')}
Logs:     ${path.join(DIR, 'daemon')}`);
  });
  svc.install();
} else {
  svc.on('uninstall', () => console.log('The "Claude Remote Web" service was removed.'));
  svc.on('alreadyuninstalled', () => console.log('The service is not installed.'));
  svc.uninstall();
}

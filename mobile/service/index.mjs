// Claude Remote web host.
// Serves the app (built with `npm run build:web` into ../dist) as a website,
// so it can be opened from any browser or phone on the network. Run directly
// (`npm start`) or as a Windows service (`npm run service:install`).
//
// Settings: web-config.json next to this file (created on first run)
//   port        port this website listens on
//   host        network interface to listen on (0.0.0.0 = all)
//   serverHost  computer that runs the Claude Remote service; empty = the same
//               computer this website is opened from
//   serverPort  port of the Claude Remote service

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(DIR, 'web-config.json');
const ROOT = path.resolve(DIR, '..', 'dist');
const DEFAULTS = { port: 8091, host: '0.0.0.0', serverHost: '', serverPort: 8787 };

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (fs.existsSync(CONFIG_PATH)) {
      console.error(`web-config.json is not valid JSON (${err.message}); using defaults.`);
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    }
  }
  const merged = { ...DEFAULTS, ...cfg };
  // Overrides for test runs.
  if (process.env.WEB_PORT) merged.port = Number(process.env.WEB_PORT);
  if (process.env.WEB_SERVER_PORT) merged.serverPort = Number(process.env.WEB_SERVER_PORT);
  return merged;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const config = loadConfig();

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }

  // The app asks for this to learn where the Claude Remote service is.
  if (pathname === '/config.json') {
    const live = loadConfig(); // re-read so edits apply without a restart
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ serverHost: live.serverHost, serverPort: live.serverPort }));
  }

  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('The app is not built yet. In the mobile folder run:  npm run build:web');
  }

  let file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(pathname)) {
      res.writeHead(404);
      return res.end();
    }
    file = path.join(ROOT, 'index.html'); // app route: let the app handle it
  }
  const isPage = path.basename(file) === 'index.html';
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    // File names of the app's scripts contain a hash, so they can be cached for long.
    'cache-control': !isPage && pathname.startsWith('/_expo/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(config.port, config.host, () => {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('Claude Remote web app is running. Open it in a browser:');
  for (const a of addrs.length ? addrs : ['127.0.0.1']) console.log(`  http://${a}:${config.port}`);
  console.log(`It connects to the Claude Remote service at ${config.serverHost || '(same computer)'}:${config.serverPort}.`);
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Change "port" in web-config.json.` : err.message);
  process.exit(1);
});

function shutdown() {
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (m) => {
  if (m === 'shutdown') shutdown();
});

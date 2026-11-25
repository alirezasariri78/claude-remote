// WebSocket transport: how the mobile app talks to the core.
//
// Wire format (JSON text frames):
//   client -> { type: 'auth', token }                 first message, required
//   server -> { type: 'auth_ok', host, home, ... }    or { type: 'auth_failed' }
//   client -> { type: <command>, reqId, ...params }   any core command
//   server -> { ...reply, reqId }                     or { type: 'error', reqId, message }
//   server -> { type: <event>, ... }                  live events, no reqId

import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export function startWebSocket(core, config) {
  const clients = new Set();

  const tokenMatches = (candidate) => {
    if (typeof candidate !== 'string') return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(config.token).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const send = (ws, msg) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const unsubscribe = core.subscribe((event) => {
    const data = JSON.stringify(event);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  });

  const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

  // POST /hook/permission: called by hook/permission-hook.mjs on this computer when a
  // Claude session outside this service asks for permission. Held open until answered.
  function handleHook(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!isLoopback(req.socket.remoteAddress)) return reply(403, { error: 'local only' });
    if (!tokenMatches(req.headers['x-claude-remote-token'])) return reply(401, { error: 'bad token' });
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return reply(400, { error: 'bad json' });
      }
      try {
        const decision = await core.externalPermission(input, (cancel) =>
          res.on('close', () => {
            if (!res.writableEnded) cancel();
          }),
        );
        if (!res.destroyed) reply(200, { decision });
      } catch {
        if (!res.destroyed) reply(200, { decision: null });
      }
    });
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook/permission') return handleHook(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'claude-remote', ok: true }));
  });
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

  wss.on('connection', (ws) => {
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4001, 'auth timeout');
    }, 10_000);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (!authed) {
        if (msg.type === 'auth' && tokenMatches(msg.token)) {
          authed = true;
          clearTimeout(authTimer);
          clients.add(ws);
          send(ws, { type: 'auth_ok', ...core.info() });
          for (const p of core.pendingPermissions()) send(ws, p);
        } else {
          setTimeout(() => {
            send(ws, { type: 'auth_failed' });
            ws.close(4003, 'bad token');
          }, 500);
        }
        return;
      }

      const { type, reqId, ...params } = msg;
      if (type === 'permission_response') params.via = 'app';
      try {
        const reply = await core.request(type, params);
        send(ws, { ...reply, reqId });
      } catch (err) {
        send(ws, { type: 'error', reqId, message: String(err?.message || err) });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(ws);
    });
    ws.on('error', () => {});
  });

  server.listen(config.port, config.host, () => {
    const addrs = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    console.log('Mobile app connection (WebSocket) is ready. In the app, enter:');
    for (const a of addrs.length ? addrs : ['127.0.0.1']) console.log(`  Address: ${a}:${config.port}`);
    console.log(`  Token:   ${config.token}\n`);
  });

  return {
    name: 'websocket',
    stop() {
      unsubscribe();
      for (const ws of clients) ws.close();
      server.close();
    },
  };
}

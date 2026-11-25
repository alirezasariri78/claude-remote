// Smoke test for the bridge: node test-client.mjs <address> <token> <folder>
// Sends one real prompt to Claude (uses a little of your usage).
import WebSocket from 'ws';

const [address = '127.0.0.1:8787', token = '', folder = process.cwd()] = process.argv.slice(2);
const ws = new WebSocket(`ws://${address}`);
let reqId = 0;
const waiting = new Map();
let sessionId = null;
let allowed = 0;

function request(msg) {
  const id = ++reqId;
  ws.send(JSON.stringify({ ...msg, reqId: id }));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

function done(code, why) {
  console.log(why);
  ws.close();
  setTimeout(() => process.exit(code), 200);
}

ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
ws.on('error', (e) => done(1, `connection error: ${e.message}`));

ws.on('message', async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.reqId && waiting.has(m.reqId)) {
    const w = waiting.get(m.reqId);
    waiting.delete(m.reqId);
    m.type === 'error' ? w.reject(new Error(m.message)) : w.resolve(m);
    return;
  }
  switch (m.type) {
    case 'auth_failed':
      return done(1, 'auth failed');
    case 'auth_ok': {
      console.log(`auth ok (host ${m.host})`);
      try {
        const s = await request({ type: 'list_sessions' });
        console.log(`sessions on disk: ${s.sessions.length}`);
        const d = await request({ type: 'list_dirs', path: folder });
        console.log(`folders in test dir: ${d.dirs.length}`);
        const c = await request({
          type: 'new_session',
          cwd: folder,
          prompt: 'Create a file named bridge-test.txt containing exactly the word pong, then reply with one short sentence.',
        });
        sessionId = c.sessionId;
        console.log(`session created: ${sessionId}`);
      } catch (e) {
        done(1, `request failed: ${e.message}`);
      }
      return;
    }
    case 'permission_request':
      console.log(`permission request: ${m.toolName} — ${m.title || JSON.stringify(m.input).slice(0, 120)}`);
      allowed++;
      await request({ type: 'permission_response', requestId: m.requestId, behavior: 'allow' });
      return;
    case 'stream':
      process.stdout.write(m.text);
      return;
    case 'state':
      console.log(`\n[state] ${m.state}`);
      return;
    case 'items':
      for (const i of m.items) {
        if (i.kind === 'tool') console.log(`\n[tool] ${i.name}`);
        if (i.kind === 'tool_result') console.log(`[tool result] ${i.isError ? 'ERROR ' : ''}${i.text.slice(0, 100)}`);
        if (i.kind === 'result') {
          console.log(`\n[result] error=${i.isError} cost=$${i.costUsd} ${i.text || ''}`);
          try {
            const h = await request({ type: 'open_session', sessionId });
            console.log(`history items: ${h.items.length} (${h.items.map((x) => x.kind).join(', ')})`);
            const u = await request({ type: 'get_usage' });
            console.log(`usage: ${JSON.stringify(u.usage).slice(0, 600)}`);
            await request({ type: 'stop_process', sessionId });
          } catch (e) {
            return done(1, `post-result check failed: ${e.message}`);
          }
          return done(i.isError ? 1 : 0, `permissions approved: ${allowed}. ${i.isError ? 'FAILED' : 'PASSED'}`);
        }
      }
      return;
  }
});

setTimeout(() => done(1, 'timed out after 3 minutes'), 180_000);

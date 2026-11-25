// Claude Code "PermissionRequest" hook.
// Claude Code runs this whenever a session on this computer is about to ask for
// permission (desktop app or terminal). It hands the request to the Claude
// Remote service, which shows it in Telegram and the mobile app, and waits.
//
//   remote answer  -> printed as the hook decision; Claude applies it
//   no answer, service off, any error -> prints nothing, so Claude shows its
//                                        normal prompt. This hook never blocks work.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const quit = () => process.exit(0);

try {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '..', 'bridge-config.json'), 'utf8'));
  const port = Number(process.env.CLAUDE_REMOTE_HOOK_PORT || cfg.port || 8787);
  const token = process.env.CLAUDE_REMOTE_HOOK_TOKEN || cfg.token;
  if (cfg.desktopApprovals?.enabled === false && !process.env.CLAUDE_REMOTE_HOOK_PORT) quit();
  const waitMs = (Number(cfg.desktopApprovals?.waitSeconds) || 300) * 1000 + 10_000;

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/hook/permission',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-remote-token': token },
        timeout: waitMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const decision = JSON.parse(body).decision;
            if (decision && (decision.behavior === 'allow' || decision.behavior === 'deny')) {
              process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
            }
          } catch {}
          quit();
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', quit);
    req.end(input);
  });
  process.stdin.on('error', quit);
} catch {
  quit();
}

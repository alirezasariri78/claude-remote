// Tells the user about waiting requests outside the app: notifications, the
// number on the icon, and (Android) the background connection.
//
// This watches the store directly instead of living in a React component, so it
// keeps working while the app's screen is not shown.

import { Platform } from 'react-native';
import { startKeepAlive, stopKeepAlive } from '../modules/keep-alive';
import {
  clearNotification,
  clearStaleNotifications,
  initialNotificationAction,
  notifyPermission,
  onNotificationAction,
  setBadge,
  setupPwa,
  type NotificationAction,
} from './pwa';
import { bridge } from './store';

let started = false;
let opener: ((sessionId: string) => void) | null = null;
let pendingOpen: string | null = null;
/** Allow / Deny pressed while the connection was down; sent once it is back. */
const queued: { requestId: string; behavior: 'allow' | 'deny' }[] = [];

/** The app registers how to show a session; a tapped notification uses it. */
export function setSessionOpener(fn: ((sessionId: string) => void) | null) {
  opener = fn;
  if (fn && pendingOpen) {
    fn(pendingOpen);
    pendingOpen = null;
  }
}

function handle(a: NotificationAction) {
  if (a.action === 'open') {
    if (opener) opener(a.sessionId);
    else pendingOpen = a.sessionId;
    return;
  }
  clearNotification(a.requestId);
  if (bridge.getState().status === 'connected') bridge.answerPermission(a.requestId, a.action);
  else queued.push({ requestId: a.requestId, behavior: a.action });
}

export async function startAlerts(): Promise<void> {
  if (started) return;
  started = true;
  await setupPwa();

  let seen = new Set<string>();
  let count = -1;
  let alive = false;
  let lastSync = 0;

  const check = () => {
    const s = bridge.getState();

    const now = new Set(s.permissions.map((p) => p.requestId));
    for (const p of s.permissions) {
      if (seen.has(p.requestId)) continue;
      notifyPermission(p, s.sessions.find((x) => x.id === p.sessionId)?.title ?? 'Session');
    }
    for (const id of seen) if (!now.has(id)) clearNotification(id);
    seen = now;
    // Back online (or the app was restarted): remove notifications of requests
    // that were answered or ended while this phone was away.
    if (s.syncedAt && s.syncedAt !== lastSync) {
      lastSync = s.syncedAt;
      clearStaleNotifications(now);
    }

    if (s.permissions.length !== count) {
      count = s.permissions.length;
      setBadge(count);
    }

    if (s.status === 'connected' && queued.length) {
      for (const q of queued.splice(0)) bridge.answerPermission(q.requestId, q.behavior);
    }

    if (Platform.OS === 'android') {
      const want = s.status === 'connected' || s.status === 'reconnecting';
      if (want && !alive) {
        alive = startKeepAlive('Claude Remote is connected', 'Watching for permission requests from your PC.');
      } else if (!want && alive) {
        stopKeepAlive();
        alive = false;
      }
    }
  };
  bridge.subscribe(check);
  check();

  onNotificationAction(handle);
  const first = initialNotificationAction();
  if (first) handle(first);
}

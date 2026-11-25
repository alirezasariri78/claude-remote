// Installable web app (PWA) support: manifest, service worker, the number on
// the app icon, and notifications. Everything here is a no-op outside a browser.
//
// Browsers only allow the service worker, notifications and the icon number on
// a secure page: https, or http://localhost. On plain http://<ip> the app still
// works, but it cannot be installed as an app.

import { Platform } from 'react-native';
import { setupViewport } from './keyboard';
import type { PermissionRequest } from './protocol';

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined';
const nav: any = isWeb ? navigator : null;

function addHead(tag: string, attrs: Record<string, string>) {
  const key = attrs.rel ?? attrs.name ?? '';
  if (document.head.querySelector(`${tag}[data-pwa="${key}"]`)) return;
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.setAttribute('data-pwa', key);
  document.head.appendChild(el);
}

/** True when the browser allows installing, notifications and the icon number here. */
export function pwaAvailable(): boolean {
  return isWeb && window.isSecureContext && 'serviceWorker' in nav;
}

export function setupPwa() {
  if (!isWeb) return;
  setupViewport();
  addHead('link', { rel: 'manifest', href: '/manifest.json' });
  addHead('link', { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' });
  addHead('link', { rel: 'icon', type: 'image/png', href: '/icons/favicon.png' });
  addHead('meta', { name: 'theme-color', content: '#262624' });
  addHead('meta', { name: 'mobile-web-app-capable', content: 'yes' });
  addHead('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  addHead('meta', { name: 'apple-mobile-web-app-title', content: 'Claude Remote' });
  if (pwaAvailable()) nav.serviceWorker.register('/sw.js').catch(() => {});
}

/** The number shown on the installed app's icon. 0 removes it. */
export function setBadge(count: number) {
  if (!isWeb) return;
  try {
    if (count > 0 && nav.setAppBadge) nav.setAppBadge(count).catch(() => {});
    else if (count <= 0 && nav.clearAppBadge) nav.clearAppBadge().catch(() => {});
  } catch {}
}

/** What the user did with a notification. Only the Android app reports these. */
export type NotificationAction = { action: 'open' | 'allow' | 'deny'; sessionId: string; requestId: string };

export function onNotificationAction(_handler: (a: NotificationAction) => void): () => void {
  return () => {};
}

/** The notification that started the app, if any. */
export function initialNotificationAction(): NotificationAction | null {
  return null;
}

export type NotifyState ='unsupported' | 'insecure' | 'default' | 'granted' | 'denied';

export function notifyState(): NotifyState {
  if (!isWeb || typeof Notification === 'undefined') return 'unsupported';
  if (!pwaAvailable()) return 'insecure';
  return Notification.permission as NotifyState;
}

/** Must be called from a tap or click. */
export async function enableNotifications(): Promise<NotifyState> {
  if (notifyState() === 'default') {
    try {
      await Notification.requestPermission();
    } catch {}
  }
  return notifyState();
}

/** Tell the user about a request while the app is not on screen. */
export async function notifyPermission(p: PermissionRequest, sessionTitle: string) {
  if (notifyState() !== 'granted' || !document.hidden) return;
  try {
    const reg = await nav.serviceWorker.ready;
    const question = p.toolName === 'AskUserQuestion';
    await reg.showNotification(question ? 'Claude has a question' : 'Claude needs your permission', {
      body: `${sessionTitle}\n${p.title ?? p.toolName}`,
      tag: p.requestId,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      renotify: true,
    });
  } catch {}
}

/** Remove every request notification whose request is not in `keep`. */
export async function clearStaleNotifications(keep: Set<string>) {
  if (notifyState() !== 'granted') return;
  try {
    const reg = await nav.serviceWorker.ready;
    for (const n of await reg.getNotifications()) if (n.tag && !keep.has(n.tag)) n.close();
  } catch {}
}

/** Remove the notification of a request that has been answered. */
export async function clearNotification(requestId: string) {
  if (notifyState() !== 'granted') return;
  try {
    const reg = await nav.serviceWorker.ready;
    for (const n of await reg.getNotifications({ tag: requestId })) n.close();
  } catch {}
}

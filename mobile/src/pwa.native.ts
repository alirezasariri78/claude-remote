// Android/iOS version of pwa.ts (Metro picks this file for native builds).
// Same functions, backed by local notifications: the app tells you about a
// request while it is in the background, and puts the waiting count on its icon.
//
// These are local notifications, not push: they are raised by the app itself, so
// they stop once the phone's system has fully stopped the app.

import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { PermissionRequest } from './protocol';

export type NotifyState = 'unsupported' | 'insecure' | 'default' | 'granted' | 'denied';

const CHANNEL = 'permissions';
const CATEGORY = 'permission';
let state: NotifyState = 'default';

function read(p: { granted: boolean; canAskAgain: boolean }): NotifyState {
  return p.granted ? 'granted' : p.canAskAgain ? 'default' : 'denied';
}

export function pwaAvailable(): boolean {
  return false;
}

/** Prepares notifications and reads whether they are allowed. */
export async function setupPwa(): Promise<void> {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    if (Platform.OS === 'android') {
      // The channel must exist before Android 13+ will show the permission prompt.
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Permission requests',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 150, 250],
        showBadge: true,
      });
    }
    // Allow / Deny buttons on the notification itself; they answer without opening the app.
    await Notifications.setNotificationCategoryAsync(CATEGORY, [
      { identifier: 'allow', buttonTitle: 'Allow', options: { opensAppToForeground: false } },
      { identifier: 'deny', buttonTitle: 'Deny', options: { opensAppToForeground: false, isDestructive: true } },
    ]);
    state = read(await Notifications.getPermissionsAsync());
  } catch {
    state = 'unsupported';
  }
}

/** What the user did with a notification: tapped it, or pressed Allow / Deny. */
export type NotificationAction = { action: 'open' | 'allow' | 'deny'; sessionId: string; requestId: string };

function toAction(r: Notifications.NotificationResponse | null): NotificationAction | null {
  const data = r?.notification.request.content.data as { sessionId?: unknown; requestId?: unknown } | undefined;
  if (!r || typeof data?.sessionId !== 'string' || typeof data?.requestId !== 'string') return null;
  const id = r.actionIdentifier;
  const action = id === 'allow' ? 'allow' : id === 'deny' ? 'deny' : 'open';
  return { action, sessionId: data.sessionId, requestId: data.requestId };
}

export function onNotificationAction(handler: (a: NotificationAction) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const a = toAction(r);
    if (a) handler(a);
  });
  return () => sub.remove();
}

/** The notification that started the app, if any. Reported once. */
export function initialNotificationAction(): NotificationAction | null {
  try {
    const a = toAction(Notifications.getLastNotificationResponse());
    if (a) Notifications.clearLastNotificationResponse();
    return a;
  } catch {
    return null;
  }
}

/** The number shown on the app's icon. 0 removes it. Not every launcher shows a number. */
export function setBadge(count: number) {
  if (state !== 'granted') return;
  Notifications.setBadgeCountAsync(Math.max(0, count)).catch(() => {});
}

export function notifyState(): NotifyState {
  return state;
}

export async function enableNotifications(): Promise<NotifyState> {
  try {
    state = read(await Notifications.requestPermissionsAsync());
  } catch {}
  return state;
}

/** Tell the user about a request while the app is not on screen. */
export async function notifyPermission(p: PermissionRequest, sessionTitle: string) {
  if (state !== 'granted' || AppState.currentState === 'active') return;
  try {
    const question = p.toolName === 'AskUserQuestion';
    await Notifications.scheduleNotificationAsync({
      identifier: p.requestId,
      content: {
        title: question ? 'Claude has a question' : 'Claude needs your permission',
        body: `${sessionTitle}\n${p.title ?? p.toolName}`,
        data: { sessionId: p.sessionId, requestId: p.requestId },
        // A question needs an answer typed or picked in the app, so it gets no buttons.
        ...(question ? {} : { categoryIdentifier: CATEGORY }),
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  } catch {}
}

/** Remove every request notification whose request is not in `keep`. */
export async function clearStaleNotifications(keep: Set<string>) {
  try {
    for (const n of await Notifications.getPresentedNotificationsAsync()) {
      const id = (n.request.content.data as { requestId?: unknown } | undefined)?.requestId;
      if (typeof id === 'string' && !keep.has(id)) await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  } catch {}
}

/** Remove the notification of a request that has been answered. */
export async function clearNotification(requestId: string) {
  if (state !== 'granted') return;
  try {
    await Notifications.dismissNotificationAsync(requestId);
  } catch {}
}

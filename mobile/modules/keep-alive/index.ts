// Android only: keeps the app connected after the user leaves it, with a
// permanent "connected" notification. On other platforms these do nothing.

import { AppRegistry, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

const native: { start(title: string, text: string): boolean; stop(): void } | null =
  Platform.OS === 'android' ? requireOptionalNativeModule('KeepAlive') : null;

/** Must run once at startup, before the service is started. */
export function registerKeepAliveTask() {
  if (Platform.OS !== 'android') return;
  // Never finishes on its own: it only exists so timers keep running in the background.
  AppRegistry.registerHeadlessTask('ClaudeRemoteKeepAlive', () => () => new Promise<void>(() => {}));
}

export const keepAliveAvailable = native != null;

/** Returns false when Android refused (the app has to be on screen to start it). */
export function startKeepAlive(title: string, text: string): boolean {
  try {
    return native ? native.start(title, text) : false;
  } catch {
    return false;
  }
}

export function stopKeepAlive() {
  try {
    native?.stop();
  } catch {}
}

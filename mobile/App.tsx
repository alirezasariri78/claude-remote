import React, { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Button, Sheet } from './src/components/ui';
import { ChatScreen } from './src/screens/ChatScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { NewSessionSheet } from './src/screens/NewSessionSheet';
import { SessionsScreen } from './src/screens/SessionsScreen';
import { UsageSheet } from './src/screens/UsageSheet';
import { setSessionOpener, startAlerts } from './src/alerts';
import { enableNotifications, notifyState, setBadge } from './src/pwa';
import { bridge, useApp } from './src/store';
import { serif, useTheme } from './src/theme';

const SESSION_KEY = 'claude-remote.session';

function Main() {
  const t = useTheme();
  const app = useApp();
  const { width } = useWindowDimensions();
  const wide = width >= 820; // tablet / desktop: sidebar and chat side by side
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  // Remember the open session, so a page refresh returns to it.
  const setSessionId = (id: string | null) => {
    setSessionIdState(id);
    if (id) AsyncStorage.setItem(SESSION_KEY, id).catch(() => {});
    else AsyncStorage.removeItem(SESSION_KEY).catch(() => {});
  };
  const [newOpen, setNewOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    bridge.init();
    AsyncStorage.getItem(SESSION_KEY)
      .then((id) => id && setSessionIdState(id))
      .catch(() => {});
  }, []);

  useEffect(() => {
    bridge.setActive(sessionId);
  }, [sessionId]);

  // Website only: page background and scrollbars in the app's colors.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = `
      html, body { background: ${t.bg}; color-scheme: ${t.dark ? 'dark' : 'light'}; }
      * { scrollbar-width: thin; scrollbar-color: ${t.border} transparent; }
      *::-webkit-scrollbar { width: 10px; height: 10px; }
      *::-webkit-scrollbar-track, *::-webkit-scrollbar-corner { background: transparent; }
      *::-webkit-scrollbar-thumb { background-color: ${t.border}; border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
      *::-webkit-scrollbar-thumb:hover { background-color: ${t.textMuted}; }
      *::-webkit-scrollbar-button { display: none; }
    `;
    document.head.appendChild(style);
    return () => style.remove();
  }, [t]);

  // Installed app: notify about each new request while the app is in the
  // background, and remove the notification once it is answered.
  // The watching itself lives in src/alerts.ts, outside React.
  const [notify, setNotify] = useState(notifyState());
  useEffect(() => {
    // On Android the state is only known after setup has asked the system.
    startAlerts().then(() => setNotify(notifyState()));
    // A tapped notification opens its session.
    setSessionOpener((id) => setSessionId(id));
    return () => setSessionOpener(null);
  }, []);

  // Browser tab title and the number on the installed app's icon.
  const waiting = app.permissions.length;
  useEffect(() => {
    setBadge(waiting);
  }, [waiting, notify]);
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.title = waiting ? '(' + waiting + ') Claude Remote' : 'Claude Remote';
    }
  }, [waiting]);

  // "Allowed on the computer" and similar: show for a few seconds.
  const note = app.note;
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => bridge.clearNote(), 5000);
    return () => clearTimeout(id);
  }, [note]);

  // Android back button: chat -> session list.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sessionId && !wide) {
        setSessionId(null);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [sessionId, wide]);

  // The open session was deleted.
  useEffect(() => {
    if (sessionId && app.sessionsLoaded && !app.sessions.some((s) => s.id === sessionId) && !app.chats[sessionId]) {
      setSessionId(null);
    }
  }, [sessionId, app.sessions, app.sessionsLoaded, app.chats]);

  if (!app.ready) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }
  if (app.status === 'idle' || app.status === 'connecting') return <ConnectScreen />;

  const sidebar = (
    <SessionsScreen
      selectedId={sessionId}
      onSelect={setSessionId}
      onNew={() => setNewOpen(true)}
      onUsage={() => setUsageOpen(true)}
      onSettings={() => setSettingsOpen(true)}
    />
  );
  const chat = sessionId ? (
    <ChatScreen key={sessionId} sessionId={sessionId} onBack={wide ? undefined : () => setSessionId(null)} />
  ) : (
    <View style={[styles.center, { backgroundColor: t.bg }]}>
      <Text style={{ color: t.accent, fontSize: 28 }}>✳</Text>
      <Text style={{ color: t.textSecondary, fontFamily: serif, fontSize: 24, marginTop: 8 }}>Pick a session to continue</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: 340, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: t.border }}>{sidebar}</View>
          <View style={{ flex: 1 }}>{chat}</View>
        </View>
      ) : sessionId ? (
        chat
      ) : (
        sidebar
      )}

      {note && (
        <Pressable
          onPress={() => {
            bridge.clearNote();
            setSessionId(note.sessionId);
          }}
          accessibilityRole="alert"
          style={[styles.note, { backgroundColor: t.surface, borderColor: t.border }]}
        >
          <Text numberOfLines={2} style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>
            {note.text}
          </Text>
        </Pressable>
      )}

      <NewSessionSheet
        visible={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => {
          setNewOpen(false);
          setSessionId(id);
        }}
      />
      <UsageSheet visible={usageOpen} onClose={() => setUsageOpen(false)} />
      <Sheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} title="Connection">
        <View style={{ gap: 10 }}>
          <Text style={{ color: t.textSecondary, fontSize: 14.5, lineHeight: 21 }}>
            Connected to {app.host ?? 'your computer'} at {app.address}.
          </Text>
          {app.desktopApprovals !== null && (
            <>
              <Text style={{ color: t.textSecondary, fontSize: 14, lineHeight: 20 }}>
                Permission prompts from sessions running in the desktop app or a terminal on the computer:{' '}
                <Text style={{ fontWeight: '700' }}>{app.desktopApprovals ? 'sent here' : 'shown on the computer only'}</Text>.
              </Text>
              <Button
                label={app.desktopApprovals ? 'Stop sending them here' : 'Send them here'}
                onPress={() => bridge.setDesktopApprovals(!app.desktopApprovals)}
              />
            </>
          )}
          {notify === 'default' && (
            <Button label="Turn on notifications" onPress={() => enableNotifications().then(setNotify)} />
          )}
          {notify === 'granted' && (
            <Text style={{ color: t.textMuted, fontSize: 13.5, lineHeight: 19 }}>
              Notifications are on: you are told about requests while the app is in the background.
            </Text>
          )}
          {Platform.OS === 'android' && (
            <>
              <Text style={{ color: t.textMuted, fontSize: 13.5, lineHeight: 19 }}>
                To keep receiving requests with the screen off, set Claude Remote to "Not optimised" / "Unrestricted"
                in the battery settings.
              </Text>
              <Button
                label="Open battery settings"
                onPress={() => {
                  Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() =>
                    Linking.openSettings().catch(() => {}),
                  );
                }}
              />
            </>
          )}
          {notify === 'denied' && (
            <Text style={{ color: t.textMuted, fontSize: 13.5, lineHeight: 19 }}>
              {Platform.OS === 'web'
                ? "Notifications are blocked for this site in the browser's settings."
                : "Notifications are blocked. Allow them for Claude Remote in the phone's app settings."}
            </Text>
          )}
          {notify === 'insecure' && (
            <Text style={{ color: t.textMuted, fontSize: 13.5, lineHeight: 19 }}>
              Installing as an app, notifications and the icon number need a secure (https) address.
            </Text>
          )}
          <Button
            label="Disconnect and forget token"
            variant="danger"
            onPress={() => {
              setSettingsOpen(false);
              setSessionId(null);
              bridge.disconnect(true);
            }}
          />
        </View>
      </Sheet>
    </View>
  );
}

export default function App() {
  const t = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Main />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  note: {
    position: 'absolute',
    top: 54,
    alignSelf: 'center',
    maxWidth: 520,
    marginHorizontal: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});

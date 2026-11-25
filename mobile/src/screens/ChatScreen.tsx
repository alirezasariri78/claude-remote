import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Markdown } from '../components/Markdown';
import { MessageItem } from '../components/MessageItem';
import { PermissionCard } from '../components/PermissionCard';
import { KeyboardView, Sheet } from '../components/ui';
import { useKeyboardVisible } from '../keyboard';
import { Item, MODE_LABELS, PermissionMode } from '../protocol';
import { bridge, useApp } from '../store';
import { serif, useTheme } from '../theme';
import { baseName } from '../util';

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan'];
const MODE_HELP: Record<PermissionMode, string> = {
  default: 'Claude asks before editing files or running commands.',
  acceptEdits: 'File edits are approved automatically. Commands still ask.',
  plan: 'Claude researches and proposes a plan without changing anything.',
};

export function ChatScreen({ sessionId, onBack }: { sessionId: string; onBack?: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const app = useApp();
  const chat = app.chats[sessionId];
  const session = app.sessions.find((s) => s.id === sessionId);
  const permissions = app.permissions.filter((p) => p.sessionId === sessionId);
  const [draft, setDraft] = useState('');
  const [modeOpen, setModeOpen] = useState(false);
  const listRef = useRef<FlatList<Item>>(null);
  const stick = useRef(true);
  // The list stays hidden until it is placed at the newest message, so opening
  // a session never shows a jump from the top.
  const [placed, setPlaced] = useState(false);
  // While older messages are added above, keep the message being read in place (web).
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const scrollNode = (): any => (listRef.current as any)?.getScrollableNode?.() ?? null;
  const toEnd = (animated = false) => {
    const node = Platform.OS === 'web' ? scrollNode() : null;
    if (node && !animated) node.scrollTop = node.scrollHeight;
    else listRef.current?.scrollToEnd({ animated });
  };

  useEffect(() => {
    stick.current = true;
    bridge.openSession(sessionId);
  }, [sessionId]);

  // Older messages were added above: shift the scroll position by their height,
  // before the browser paints, so the message being read does not move.
  const firstKey = chat?.items[0] ? `${chat.items[0].kind}:${chat.items[0].id}` : '';
  useLayoutEffect(() => {
    const a = anchor.current;
    const node = a ? scrollNode() : null;
    if (a && node) node.scrollTop = a.top + (node.scrollHeight - a.height);
  }, [firstKey]);

  // Fallback: size events do not fire while the tab is in the background, so
  // place the list from a timer once the messages have arrived.
  const loaded = !!chat?.loaded;
  useEffect(() => {
    if (!loaded || placed) return;
    const id = setTimeout(() => {
      toEnd();
      setPlaced(true);
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, placed]);

  // The keyboard takes space from the list: keep the newest message in view
  // if the user was reading the end of the conversation.
  const keyboardVisible = useKeyboardVisible();
  useEffect(() => {
    if (!keyboardVisible || !stick.current) return;
    const ids = [60, 250].map((ms) => setTimeout(() => toEnd(), ms));
    return () => ids.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardVisible]);

  // A new permission request must be seen: jump to it.
  useEffect(() => {
    if (permissions.length) {
      stick.current = true;
      const id = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      return () => clearTimeout(id);
    }
  }, [permissions.length]);

  const onContentSize = useCallback((_w: number, height: number) => {
    const a = anchor.current;
    if (a) {
      const node = scrollNode();
      if (node) node.scrollTop = a.top + (height - a.height);
      return;
    }
    if (stick.current) toEnd();
    // A timer, not an animation frame: frames do not run while the tab is in the background.
    if (height > 0) setTimeout(() => setPlaced(true), 0);
  }, []);

  const loadOlder = () => {
    if (!chat || chat.start <= 0 || chat.loadingOlder || !placed) return;
    if (Platform.OS === 'web') {
      const node = scrollNode();
      if (node) anchor.current = { height: node.scrollHeight, top: node.scrollTop };
    }
    bridge.loadOlder(sessionId).finally(() => {
      // The list adds rows in a few batches; keep correcting until it settles.
      const fix = () => {
        const a = anchor.current;
        const node = a ? scrollNode() : null;
        if (a && node) node.scrollTop = a.top + (node.scrollHeight - a.height);
      };
      for (const ms of [30, 90, 180, 300, 450]) setTimeout(fix, ms);
      setTimeout(() => (anchor.current = null), 500);
    });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 120;
    if (contentOffset.y < 300) loadOlder();
  };

  const state = chat?.state ?? 'idle';
  const busy = state !== 'idle';
  const mode = chat?.permissionMode ?? 'default';
  const offline = app.status !== 'connected';

  const submit = () => {
    const text = draft.trim();
    if (!text || offline) return;
    setDraft('');
    stick.current = true;
    bridge.sendPrompt(sessionId, text).catch(() => setDraft(text));
  };

  const title = session?.title ?? 'Session';
  const subtitle = [baseName(session?.cwd), session?.branch, chat?.model].filter(Boolean).join('  ·  ');

  return (
    <KeyboardView style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: t.border }]}>
        {onBack && (
          <Pressable onPress={onBack} hitSlop={10} style={styles.back} accessibilityRole="button" accessibilityLabel="Back to sessions">
            <Text style={{ color: t.text, fontSize: 28, lineHeight: 30 }}>‹</Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>
            {title}
          </Text>
          {!!subtitle && (
            <Text numberOfLines={1} style={{ color: t.textMuted, fontSize: 12.5, marginTop: 1 }}>
              {subtitle}
            </Text>
          )}
        </View>
        {busy && <ActivityIndicator size="small" color={t.accent} />}
      </View>

      {!chat?.loaded ? (
        <View style={styles.center}>
          <ActivityIndicator color={t.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={{ flex: 1, opacity: placed || !chat.items.length ? 1 : 0 }}
          contentContainerStyle={styles.list}
          initialNumToRender={60}
          maxToRenderPerBatch={60}
          windowSize={41}
          maintainVisibleContentPosition={Platform.OS === 'web' ? undefined : { minIndexForVisible: 0 }}
          ListHeaderComponent={
            chat.start > 0 ? (
              <Text style={{ color: t.textMuted, fontSize: 12.5, textAlign: 'center', paddingBottom: 12 }}>
                {chat.loadingOlder ? 'Loading earlier messages…' : 'Scroll up for earlier messages'}
              </Text>
            ) : undefined
          }
          data={chat.items}
          keyExtractor={(i) => `${i.kind}:${i.id}`}
          renderItem={({ item }) => <MessageItem item={item} />}
          onContentSizeChange={onContentSize}
          onScroll={onScroll}
          scrollEventThrottle={64}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={Gap}
          ListEmptyComponent={
            <Text style={{ color: t.textMuted, fontFamily: serif, fontSize: 20, textAlign: 'center', marginTop: 80 }}>
              No messages in this session yet.
            </Text>
          }
          ListFooterComponent={
            <View style={{ gap: 10, marginTop: 10 }}>
              {!!chat.stream && <Markdown text={chat.stream} />}
              {permissions.map((p) => (
                <PermissionCard key={p.requestId} p={p} />
              ))}
              {state === 'running' && !chat.stream && permissions.length === 0 && (
                <Text style={{ color: t.textMuted, fontSize: 13.5 }}>Claude is working…</Text>
              )}
            </View>
          }
        />
      )}

      {/* With the keyboard open there is no gesture bar below the composer to clear. */}
      <View style={[styles.footer, { paddingBottom: keyboardVisible ? 10 : Math.max(insets.bottom, 10) }]}>
        {!!chat?.error && (
          <Text style={{ color: t.danger, fontSize: 13.5, lineHeight: 19 }} accessibilityRole="alert">
            {chat.error}
          </Text>
        )}
        {offline && (
          <Text style={{ color: t.warn, fontSize: 13 }}>Reconnecting to your computer…</Text>
        )}
        <View style={[styles.composer, { backgroundColor: t.surface, borderColor: t.border }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={permissions.length ? 'Answer the request above, or type…' : busy ? 'Queue a follow-up…' : 'Reply to Claude…'}
            placeholderTextColor={t.textMuted}
            multiline
            style={[styles.input, { color: t.text }]}
            accessibilityLabel="Message"
            onKeyPress={(e: any) => {
              // Desktop / web: Enter sends, Shift+Enter makes a new line.
              if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <View style={styles.composerRow}>
            <Pressable
              onPress={() => setModeOpen(true)}
              style={[styles.modeChip, { borderColor: t.border }]}
              accessibilityRole="button"
              accessibilityLabel={`Permission mode: ${MODE_LABELS[mode]}`}
            >
              <Text style={{ color: t.textSecondary, fontSize: 12.5, fontWeight: '600' }}>{MODE_LABELS[mode]}</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            {busy && !draft.trim() ? (
              <Pressable
                onPress={() => bridge.interrupt(sessionId)}
                style={[styles.send, { backgroundColor: t.surfaceAlt, borderColor: t.border, borderWidth: 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Stop"
              >
                <View style={{ width: 11, height: 11, borderRadius: 2, backgroundColor: t.text }} />
              </Pressable>
            ) : (
              <Pressable
                onPress={submit}
                disabled={!draft.trim() || offline}
                style={[styles.send, { backgroundColor: t.accent, opacity: !draft.trim() || offline ? 0.4 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Send"
              >
                <Text style={{ color: t.accentText, fontSize: 18, fontWeight: '700', lineHeight: 20 }}>↑</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      <Sheet visible={modeOpen} onClose={() => setModeOpen(false)} title="Permission mode">
        <View style={{ gap: 8 }}>
          {MODES.map((m) => (
            <Pressable
              key={m}
              onPress={() => {
                setModeOpen(false);
                if (m !== mode) bridge.setMode(sessionId, m);
              }}
              accessibilityRole="radio"
              accessibilityState={{ checked: m === mode }}
              style={[styles.modeRow, { borderColor: m === mode ? t.accent : t.border, backgroundColor: t.surface }]}
            >
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{MODE_LABELS[m]}</Text>
              <Text style={{ color: t.textMuted, fontSize: 13, lineHeight: 18 }}>{MODE_HELP[m]}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </KeyboardView>
  );
}

function Gap() {
  return <View style={{ height: 10 }} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { width: 32, height: 40, justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: 16, paddingVertical: 14, maxWidth: 820, width: '100%', alignSelf: 'center' },
  footer: { paddingHorizontal: 12, paddingTop: 6, gap: 8, maxWidth: 820, width: '100%', alignSelf: 'center' },
  composer: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8 },
  input: { fontSize: 16, lineHeight: 22, minHeight: 40, maxHeight: 140, paddingVertical: 8, outlineWidth: 0 } as any,
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modeChip: { height: 32, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1, justifyContent: 'center' },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  modeRow: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 3 },
});

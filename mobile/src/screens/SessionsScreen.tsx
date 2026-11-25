import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PermissionCard } from '../components/PermissionCard';
import { Button, Field, Label, Sheet } from '../components/ui';
import type { SessionInfo } from '../protocol';
import { bridge, useApp } from '../store';
import { serif, useTheme } from '../theme';
import { baseName, dayBucket, relativeTime } from '../util';

type GroupBy = 'recent' | 'project' | 'section';
const GROUPS: { key: GroupBy; label: string }[] = [
  { key: 'section', label: 'Sections' },
  { key: 'project', label: 'Projects' },
  { key: 'recent', label: 'Recent' },
];
const DAY_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];

type Props = {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onUsage: () => void;
  onSettings: () => void;
};

export function SessionsScreen({ selectedId, onSelect, onNew, onUsage, onSettings }: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const app = useApp();
  const [groupBy, setGroupBy] = useState<GroupBy>('section');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [menuFor, setMenuFor] = useState<SessionInfo | null>(null);

  const archivedCount = app.sessions.filter((s) => s.archived).length;

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = app.sessions.filter(
      (s) =>
        (showArchived || !s.archived) &&
        (!q || s.title.toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q)),
    );
    const groups = new Map<string, SessionInfo[]>();
    for (const s of visible) {
      const key =
        groupBy === 'recent' ? dayBucket(s.lastModified) : groupBy === 'project' ? baseName(s.cwd) : s.section || 'No section';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    let keys = [...groups.keys()];
    if (groupBy === 'recent') keys = DAY_ORDER.filter((k) => groups.has(k));
    else if (groupBy === 'section') {
      keys.sort((a, b) => (a === 'No section' ? 1 : b === 'No section' ? -1 : a.localeCompare(b)));
    }
    return keys.map((title) => {
      const all = groups.get(title)!;
      const closed = !!collapsed[groupBy + ':' + title] && !q;
      return { title, count: all.length, closed, data: closed ? [] : all };
    });
  }, [app.sessions, groupBy, search, showArchived, collapsed]);

  const five = app.usage?.rateLimits?.five_hour?.utilization;
  const statusColor = app.status === 'connected' ? t.ok : t.warn;

  return (
    <View style={[styles.root, { backgroundColor: t.sidebar, paddingTop: insets.top + 10 }]}>
      <View style={styles.top}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontFamily: serif, fontSize: 22, fontWeight: '600' }}>Claude Remote</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor }} />
            <Text numberOfLines={1} style={{ color: t.textMuted, fontSize: 12.5 }}>
              {app.status === 'connected' ? app.host ?? 'Connected' : 'Reconnecting…'}
            </Text>
          </View>
        </View>
        <Pressable onPress={onSettings} hitSlop={8} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Connection settings">
          <Text style={{ color: t.textSecondary, fontSize: 13.5, fontWeight: '600' }}>Settings</Text>
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: 14, gap: 10 }}>
        <Button label="+  New session" variant="primary" onPress={onNew} />
        <Pressable
          onPress={onUsage}
          style={[styles.usage, { backgroundColor: t.surface, borderColor: t.border }]}
          accessibilityRole="button"
          accessibilityLabel="Usage and limits"
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ color: t.textSecondary, fontSize: 13, fontWeight: '600', flex: 1 }}>Usage limits</Text>
            <Text style={{ color: t.textMuted, fontSize: 12.5 }}>
              {typeof five === 'number' ? `${Math.round(five)}% of 5-hour limit` : app.usageLoading ? 'Loading…' : 'View'}
            </Text>
          </View>
          {typeof five === 'number' && (
            <View style={[styles.track, { backgroundColor: t.surfaceAlt }]}>
              <View
                style={{
                  width: `${Math.min(100, Math.max(2, five))}%`,
                  height: '100%',
                  borderRadius: 3,
                  backgroundColor: five >= 90 ? t.danger : five >= 70 ? t.warn : t.accent,
                }}
              />
            </View>
          )}
        </Pressable>
        <Field value={search} onChangeText={setSearch} placeholder="Search sessions" accessibilityLabel="Search sessions" style={{ minHeight: 40 }} />
        <View style={[styles.segment, { backgroundColor: t.surface, borderColor: t.border }]}>
          {GROUPS.map((g) => (
            <Pressable
              key={g.key}
              onPress={() => setGroupBy(g.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: groupBy === g.key }}
              style={[styles.segmentItem, groupBy === g.key && { backgroundColor: t.surfaceAlt }]}
            >
              <Text style={{ color: groupBy === g.key ? t.text : t.textMuted, fontSize: 13, fontWeight: '600' }}>{g.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <SectionList
        style={{ flex: 1, marginTop: 6 }}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 20 }}
        sections={sections}
        keyExtractor={(s) => s.id}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => bridge.refreshSessions()} tintColor={t.accent} />
        }
        ListHeaderComponent={
          app.permissions.length ? (
            <View style={{ gap: 8, paddingHorizontal: 4, paddingTop: 10 }}>
              <Text style={{ color: t.text, fontSize: 13, fontWeight: '700' }}>
                Waiting for you ({app.permissions.length})
              </Text>
              {app.permissions.slice(0, 4).map((p) => (
                <PermissionCard
                  key={p.requestId}
                  p={p}
                  sessionTitle={app.sessions.find((x) => x.id === p.sessionId)?.title ?? 'Session'}
                  onOpen={() => onSelect(p.sessionId)}
                />
              ))}
            </View>
          ) : undefined
        }
        renderSectionHeader={({ section }) => (
          <Pressable
            onPress={() => setCollapsed((c) => ({ ...c, [groupBy + ':' + section.title]: !section.closed }))}
            accessibilityRole="button"
            accessibilityState={{ expanded: !section.closed }}
            style={styles.sectionRow}
          >
            <Text style={{ color: t.textMuted, fontSize: 10, width: 12 }}>{section.closed ? '▸' : '▾'}</Text>
            <Text style={[styles.sectionHead, { color: t.textMuted, flex: 1 }]}>{section.title}</Text>
            <Text style={{ color: t.textMuted, fontSize: 11.5 }}>{section.count}</Text>
          </Pressable>
        )}
        renderItem={({ item }) => {
          const selected = item.id === selectedId;
          const waiting = item.state === 'requires_action' || app.permissions.some((p) => p.sessionId === item.id);
          return (
            <Pressable
              onPress={() => onSelect(item.id)}
              onLongPress={() => setMenuFor(item)}
              accessibilityRole="button"
              accessibilityLabel={item.title}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: selected ? t.surfaceAlt : pressed ? t.surface : 'transparent' },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ color: item.archived ? t.textMuted : t.text, fontSize: 15, fontWeight: '500' }}>
                  {item.title}
                </Text>
                <Text numberOfLines={1} style={{ color: t.textMuted, fontSize: 12.5, marginTop: 2 }}>
                  {[relativeTime(item.lastModified), groupBy === 'project' ? item.section : baseName(item.cwd), item.archived ? 'Archived' : null]
                    .filter(Boolean)
                    .join('  ·  ')}
                </Text>
              </View>
              {waiting ? (
                <View style={[styles.badge, { backgroundColor: t.accent }]}>
                  <Text style={{ color: t.accentText, fontSize: 11, fontWeight: '700' }}>Needs you</Text>
                </View>
              ) : item.state === 'running' ? (
                <ActivityIndicator size="small" color={t.accent} />
              ) : null}
              <Pressable
                onPress={() => setMenuFor(item)}
                hitSlop={8}
                style={styles.more}
                accessibilityRole="button"
                accessibilityLabel={`Actions for ${item.title}`}
              >
                <Text style={{ color: t.textMuted, fontSize: 18, lineHeight: 20 }}>⋯</Text>
              </Pressable>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <Text style={{ color: t.textMuted, fontSize: 14, textAlign: 'center', marginTop: 40, paddingHorizontal: 20, lineHeight: 20 }}>
            {!app.sessionsLoaded
              ? 'Loading sessions…'
              : search
                ? 'No sessions match your search.'
                : 'No sessions yet. Start one with New session.'}
          </Text>
        }
        ListFooterComponent={
          archivedCount > 0 ? (
            <Pressable onPress={() => setShowArchived((v) => !v)} style={{ padding: 14 }} accessibilityRole="button">
              <Text style={{ color: t.textMuted, fontSize: 13, textAlign: 'center' }}>
                {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
              </Text>
            </Pressable>
          ) : undefined
        }
      />

      <SessionMenu session={menuFor} onClose={() => setMenuFor(null)} />
    </View>
  );
}

function SessionMenu({ session, onClose }: { session: SessionInfo | null; onClose: () => void }) {
  const t = useTheme();
  const app = useApp();
  const [view, setView] = useState<'menu' | 'rename' | 'section' | 'delete'>('menu');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setView('menu');
    setText('');
    setError(null);
    onClose();
  };
  const run = (p: Promise<unknown>) => p.then(close).catch((e) => setError(e.message));

  const existing = useMemo(
    () => [...new Set(app.sessions.map((s) => s.section).filter((s): s is string => !!s))].sort(),
    [app.sessions],
  );
  if (!session) return null;

  const title = view === 'rename' ? 'Rename session' : view === 'section' ? 'Move to section' : view === 'delete' ? 'Delete session?' : session.title;

  return (
    <Sheet visible onClose={close} title={title}>
      <View style={{ gap: 8 }}>
        {view === 'menu' && (
          <>
            <Button label="Rename" onPress={() => { setText(session.title); setView('rename'); }} />
            <Button label={session.section ? `Section: ${session.section}` : 'Move to section'} onPress={() => { setText(''); setView('section'); }} />
            <Button label={session.archived ? 'Unarchive' : 'Archive'} onPress={() => run(bridge.archive(session.id, !session.archived))} />
            <Button label="Delete…" variant="danger" onPress={() => setView('delete')} />
          </>
        )}
        {view === 'rename' && (
          <>
            <Field value={text} onChangeText={setText} autoFocus accessibilityLabel="Session title" />
            <Button label="Save" variant="primary" disabled={!text.trim()} onPress={() => run(bridge.rename(session.id, text))} />
          </>
        )}
        {view === 'section' && (
          <>
            {existing.map((s) => (
              <Button key={s} label={s === session.section ? `${s}  ✓` : s} onPress={() => run(bridge.setSection(session.id, s))} />
            ))}
            {!!session.section && <Button label="Remove from section" onPress={() => run(bridge.setSection(session.id, null))} />}
            <Label>New section</Label>
            <Field value={text} onChangeText={setText} placeholder="Section name" accessibilityLabel="New section name" />
            <Button label="Create and move" variant="primary" disabled={!text.trim()} onPress={() => run(bridge.setSection(session.id, text))} />
          </>
        )}
        {view === 'delete' && (
          <>
            <Text style={{ color: t.textSecondary, fontSize: 14.5, lineHeight: 21 }}>
              This permanently removes “{session.title}” and its history from your computer. It cannot be undone.
            </Text>
            <Button label="Delete session" variant="danger" onPress={() => run(bridge.deleteSession(session.id))} />
            <Button label="Cancel" onPress={() => setView('menu')} />
          </>
        )}
        {!!error && <Text style={{ color: t.danger, fontSize: 13.5 }}>{error}</Text>}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12 },
  iconBtn: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 4 },
  usage: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, padding: 3 },
  segmentItem: { flex: 1, height: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  sectionHead: {
    fontSize: 11.5,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingTop: 16, paddingBottom: 6, minHeight: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 2, minHeight: 54, borderRadius: 10 },
  badge: { paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center' },
  more: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
});

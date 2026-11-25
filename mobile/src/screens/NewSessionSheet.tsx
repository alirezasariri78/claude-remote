import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Field, Label, Sheet } from '../components/ui';
import { DirListing, MODE_LABELS, PermissionMode } from '../protocol';
import { bridge, useApp } from '../store';
import { mono, useTheme } from '../theme';
import { baseName } from '../util';

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export function NewSessionSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}) {
  const t = useTheme();
  const app = useApp();
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionMode>('default');
  const [browsing, setBrowsing] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of app.sessions) {
      if (s.cwd && !seen.has(s.cwd)) {
        seen.add(s.cwd);
        out.push(s.cwd);
      }
      if (out.length >= 6) break;
    }
    return out;
  }, [app.sessions]);

  useEffect(() => {
    if (visible) {
      setError(null);
      setBrowsing(false);
      setStarting(false);
      if (!cwd && recent[0]) setCwd(recent[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const browse = async (path: string | null) => {
    setError(null);
    try {
      setListing(await bridge.listDirs(path));
      setBrowsing(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const id = await bridge.newSession(cwd.trim(), prompt.trim(), mode);
      setPrompt('');
      onCreated(id);
    } catch (e: any) {
      setError(e.message);
      setStarting(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={browsing ? 'Choose a folder' : 'New session'} tall>
      {browsing && listing ? (
        <View style={{ flex: 1, gap: 8 }}>
          <Text selectable numberOfLines={2} style={{ color: t.textSecondary, fontFamily: mono, fontSize: 12.5 }}>
            {listing.path ?? 'This computer'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {listing.parent !== null && <Button small label="Up" onPress={() => browse(listing.parent || null)} />}
            <Button small label="Home" onPress={() => browse(listing.home)} />
            <Button small label="Drives" onPress={() => browse(null)} />
          </View>
          <ScrollView style={{ flex: 1 }}>
            {listing.dirs.map((d) => (
              <Pressable
                key={d.path}
                onPress={() => browse(d.path)}
                accessibilityRole="button"
                style={[styles.dir, { borderBottomColor: t.border }]}
              >
                <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, flex: 1 }}>
                  {d.name}
                </Text>
                <Text style={{ color: t.textMuted, fontSize: 16 }}>›</Text>
              </Pressable>
            ))}
            {!listing.dirs.length && (
              <Text style={{ color: t.textMuted, fontSize: 14, paddingVertical: 20, textAlign: 'center' }}>No folders inside.</Text>
            )}
          </ScrollView>
          {!!error && <Text style={{ color: t.danger, fontSize: 13.5 }}>{error}</Text>}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Back" style={{ flex: 1 }} onPress={() => setBrowsing(false)} />
            <Button
              label="Use this folder"
              variant="primary"
              style={{ flex: 2 }}
              disabled={!listing.path}
              onPress={() => {
                if (listing.path) setCwd(listing.path);
                setBrowsing(false);
              }}
            />
          </View>
        </View>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, paddingBottom: 8 }}>
          <Label>Folder on your computer</Label>
          <Field
            value={cwd}
            onChangeText={setCwd}
            placeholder="D:\projects\my-app"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Folder path"
            style={{ fontFamily: mono, fontSize: 13.5 }}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            <Button small label="Browse…" onPress={() => browse(cwd.trim() || app.home)} />
            {recent.map((r) => (
              <Button key={r} small label={baseName(r)} variant={r === cwd ? 'primary' : 'secondary'} onPress={() => setCwd(r)} />
            ))}
          </View>

          <View style={{ height: 10 }} />
          <Label>Permission mode</Label>
          <View style={[styles.segment, { backgroundColor: t.surface, borderColor: t.border }]}>
            {MODES.map((m) => (
              <Pressable
                key={m}
                onPress={() => setMode(m)}
                accessibilityRole="radio"
                accessibilityState={{ checked: mode === m }}
                style={[styles.segmentItem, mode === m && { backgroundColor: t.surfaceAlt }]}
              >
                <Text numberOfLines={1} style={{ color: mode === m ? t.text : t.textMuted, fontSize: 12.5, fontWeight: '600' }}>
                  {MODE_LABELS[m]}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={{ height: 10 }} />
          <Label>First message</Label>
          <Field
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should Claude do?"
            multiline
            accessibilityLabel="First message"
            style={{ minHeight: 110, textAlignVertical: 'top' }}
          />
          {!!error && <Text style={{ color: t.danger, fontSize: 13.5, marginTop: 4 }}>{error}</Text>}
          <Button
            label={starting ? 'Starting…' : 'Start session'}
            variant="primary"
            disabled={starting || !cwd.trim() || !prompt.trim()}
            onPress={start}
            style={{ marginTop: 10 }}
          />
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  dir: { flexDirection: 'row', alignItems: 'center', minHeight: 46, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 4 },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, padding: 3 },
  segmentItem: { flex: 1, height: 34, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
});

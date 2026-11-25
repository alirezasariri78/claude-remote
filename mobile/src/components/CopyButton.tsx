import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../theme';

/** Copies text; works on the website without https too (browsers block the modern API there). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (await Clipboard.setStringAsync(text)) return true;
  } catch {}
  if (Platform.OS !== 'web' || typeof document === 'undefined') return false;
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A small "Copy" button for the corner of a code box. Shows "Copied" for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const t = useTheme();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const onPress = async () => {
    const ok = await copyText(text);
    setState(ok ? 'done' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  };

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        minHeight: 28,
        justifyContent: 'center',
        borderRadius: 7,
        backgroundColor: pressed ? t.border : 'transparent',
      })}
    >
      <Text style={{ fontSize: 12.5, fontWeight: '600', color: state === 'done' ? t.accent : state === 'failed' ? t.danger : t.textMuted }}>
        {state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}
      </Text>
    </Pressable>
  );
}

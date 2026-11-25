import React, { memo, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { mono, Theme, useTheme } from '../theme';
import { CopyButton } from './CopyButton';

// A small Markdown renderer: headings, lists, quotes, fenced code, tables (as
// monospace text) and inline bold / italic / code / links.

type Block =
  | { type: 'code'; text: string; lang: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: { marker: string; text: string; indent: number }[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; text: string }
  | { type: 'rule' }
  | { type: 'para'; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const lang = line.trim().slice(fence[1].length).trim().split(/\s+/)[0] ?? '';
      blocks.push({ type: 'code', text: body.join('\n'), lang });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim());
        i++;
      }
      blocks.push({ type: 'table', text: rows.join('\n') });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }
    const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const items: { marker: string; text: string; indent: number }[] = [];
      let ordered = false;
      while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (m) {
          ordered = ordered || /\d/.test(m[2]);
          items.push({ marker: /\d/.test(m[2]) ? m[2].replace(')', '.') : '•', text: m[3], indent: Math.floor(m[1].length / 2) });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ' ' + lines[i].trim();
          i++;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|\|)/.test(lines[i]) &&
      !listRe.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push({ type: 'para', text: para.join('\n') });
  }
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*?\*)/g;

function Inline({ text, t }: { text: string; t: Theme }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    const tok = m[0];
    if (m[1]) {
      parts.push(
        <Text key={key++} style={{ fontFamily: mono, fontSize: 13.5, backgroundColor: t.codeBg, color: t.text }}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (m[2]) {
      parts.push(
        <Text key={key++} style={{ fontWeight: '700' }}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (m[3]) {
      const label = tok.slice(1, tok.indexOf(']('));
      parts.push(
        <Text key={key++} style={{ color: t.accent }}>
          {label}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={key++} style={{ fontStyle: 'italic' }}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const t = useTheme();
  const blocks = useMemo(() => parse(text), [text]);
  const body = { color: t.text, fontSize: 15.5, lineHeight: 23 };
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return (
              <View key={i} style={[styles.code, { backgroundColor: t.codeBg, borderColor: t.border }]}>
                <View style={[styles.codeHead, { borderBottomColor: t.border }]}>
                  <Text style={{ flex: 1, color: t.textMuted, fontSize: 12, fontFamily: mono }}>{b.lang}</Text>
                  <CopyButton text={b.text} />
                </View>
                <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 12 }}>
                  <Text selectable style={{ fontFamily: mono, fontSize: 13, lineHeight: 19, color: t.text }}>
                    {b.text}
                  </Text>
                </ScrollView>
              </View>
            );
          case 'table':
            return (
              <ScrollView
                key={i}
                horizontal
                style={[styles.code, { backgroundColor: t.codeBg, borderColor: t.border }]}
                contentContainerStyle={{ padding: 12 }}
              >
                <Text selectable style={{ fontFamily: mono, fontSize: 12.5, lineHeight: 19, color: t.text }}>
                  {b.text}
                </Text>
              </ScrollView>
            );
          case 'heading':
            return (
              <Text
                key={i}
                selectable
                style={{ color: t.text, fontWeight: '700', fontSize: b.level <= 1 ? 20 : b.level === 2 ? 18 : 16, lineHeight: 26, marginTop: 4 }}
              >
                <Inline text={b.text} t={t} />
              </Text>
            );
          case 'list':
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((it, j) => (
                  <View key={j} style={{ flexDirection: 'row', paddingLeft: 4 + it.indent * 16 }}>
                    <Text style={[body, { color: t.textMuted, width: b.ordered ? 24 : 16 }]}>{it.marker}</Text>
                    <Text selectable style={[body, { flex: 1 }]}>
                      <Inline text={it.text} t={t} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: t.border, paddingLeft: 12 }}>
                <Text selectable style={[body, { color: t.textSecondary }]}>
                  <Inline text={b.text} t={t} />
                </Text>
              </View>
            );
          case 'rule':
            return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginVertical: 4 }} />;
          default:
            return (
              <Text key={i} selectable style={body}>
                <Inline text={b.text} t={t} />
              </Text>
            );
        }
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { gap: 10 },
  code: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexGrow: 0, overflow: 'hidden' },
  codeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 4,
    minHeight: 34,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});

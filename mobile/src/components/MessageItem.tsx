import React, { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Item } from '../protocol';
import { mono, useTheme } from '../theme';
import { formatDuration, formatTokens, toolSummary } from '../util';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';

type ToolItem = Extract<Item, { kind: 'tool' }>;

type AskedQuestion = { question: string; options?: { label: string; description?: string }[] };

/** A question Claude asked, shown as text instead of raw tool data. */
function QuestionRow({ item }: { item: ToolItem }) {
  const t = useTheme();
  const questions = item.input.questions as AskedQuestion[];
  const answered = !!item.result;
  return (
    <View style={[styles.tool, { borderColor: t.border, backgroundColor: t.surface, padding: 12, gap: 8 }]}>
      <Text style={[styles.label, { color: t.textMuted, marginTop: 0 }]}>Claude asked</Text>
      {questions.map((q, i) => (
        <View key={i} style={{ gap: 4 }}>
          <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 21, fontWeight: '600' }}>
            {q.question}
          </Text>
          {(q.options ?? []).map((o) => (
            <Text key={o.label} style={{ color: t.textSecondary, fontSize: 14, lineHeight: 20 }}>
              •  {o.label}
              {o.description ? <Text style={{ color: t.textMuted }}>{`  —  ${o.description}`}</Text> : null}
            </Text>
          ))}
        </View>
      ))}
      <Text selectable style={{ color: item.result?.isError ? t.danger : answered ? t.textSecondary : t.accent, fontSize: 13.5, lineHeight: 19 }}>
        {answered ? item.result!.text || 'Answered.' : 'Waiting for an answer'}
      </Text>
    </View>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const running = !item.result;
  const failed = !!item.result?.isError;
  const summary = toolSummary(item.name, item.input);
  const dot = failed ? t.danger : running ? t.accent : t.textMuted;
  const detail = typeof item.input.command === 'string' ? item.input.command : JSON.stringify(item.input, null, 2);

  return (
    <View style={[styles.tool, { borderColor: t.border, backgroundColor: t.surface }]}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.toolHead}
        accessibilityRole="button"
        accessibilityLabel={`${item.name} ${summary}`}
      >
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={[styles.toolName, { color: t.text }]}>{item.name}</Text>
        <Text numberOfLines={1} style={[styles.toolSummary, { color: t.textMuted }]}>
          {summary}
        </Text>
        <Text style={{ color: t.textMuted, fontSize: 12 }}>{failed ? 'Failed' : running ? 'Running' : open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && (
        <View style={[styles.toolBody, { borderTopColor: t.border }]}>
          <View style={styles.labelRow}>
            <Text style={[styles.label, { color: t.textMuted, marginTop: 0, flex: 1 }]}>
              {typeof item.input.command === 'string' ? 'Command' : 'Input'}
            </Text>
            <CopyButton text={detail} />
          </View>
          <Text selectable style={[styles.codeText, { color: t.textSecondary }]}>
            {detail}
          </Text>
          {item.result && (
            <>
              <View style={[styles.labelRow, { marginTop: 6 }]}>
                <Text style={[styles.label, { color: t.textMuted, marginTop: 0, flex: 1 }]}>{failed ? 'Error' : 'Result'}</Text>
                {!!item.result.text && <CopyButton text={item.result.text} />}
              </View>
              <Text selectable style={[styles.codeText, { color: failed ? t.danger : t.textSecondary }]}>
                {item.result.text || '(no output)'}
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

export const MessageItem = memo(function MessageItem({ item }: { item: Item }) {
  const t = useTheme();
  switch (item.kind) {
    case 'user':
      return (
        <View style={styles.userRow}>
          <View style={[styles.userBubble, { backgroundColor: t.surfaceAlt }]}>
            <Text selectable style={{ color: t.text, fontSize: 15.5, lineHeight: 22 }}>
              {item.text}
            </Text>
          </View>
        </View>
      );
    case 'assistant':
      return (
        <View style={styles.assistant}>
          <Markdown text={item.text} />
        </View>
      );
    case 'tool':
      if (item.name === 'AskUserQuestion' && Array.isArray(item.input.questions)) return <QuestionRow item={item} />;
      return <ToolRow item={item} />;
    case 'result': {
      if (item.isError) {
        return (
          <View style={[styles.errorBox, { borderColor: t.danger }]}>
            <Text selectable style={{ color: t.danger, fontSize: 14, lineHeight: 20 }}>
              {item.text || 'The turn ended with an error.'}
            </Text>
          </View>
        );
      }
      const parts: string[] = [];
      if (item.durationMs) parts.push(formatDuration(item.durationMs));
      const u = item.usage;
      if (u) {
        const total =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        if (total) parts.push(`${formatTokens(total)} tokens`);
      }
      if (typeof item.costUsd === 'number' && item.costUsd > 0) parts.push(`$${item.costUsd.toFixed(3)}`);
      if (!parts.length) return null;
      return <Text style={[styles.stats, { color: t.textMuted }]}>{parts.join('  ·  ')}</Text>;
    }
    default:
      return null;
  }
});

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end', marginTop: 10 },
  userBubble: { maxWidth: '88%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  assistant: { marginTop: 4 },
  tool: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 40 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  toolName: { fontSize: 13.5, fontWeight: '600' },
  toolSummary: { flex: 1, fontFamily: mono, fontSize: 12.5 },
  toolBody: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  codeText: { fontFamily: mono, fontSize: 12.5, lineHeight: 18 },
  label: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', minHeight: 28 },
  errorBox: { borderWidth: 1, borderRadius: 10, padding: 12 },
  stats: { fontSize: 12, marginTop: 2, marginBottom: 6 },
});

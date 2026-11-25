import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PermissionRequest, Question } from '../protocol';
import { bridge } from '../store';
import { mono, useTheme } from '../theme';
import { Button } from './ui';

function detailOf(p: PermissionRequest): string {
  const input = p.input;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') {
    const extra = typeof input.new_string === 'string' ? `\n\n${input.new_string}` : typeof input.content === 'string' ? `\n\n${input.content}` : '';
    return `${input.file_path}${extra}`;
  }
  if (typeof input.url === 'string') return input.url;
  if (typeof input.plan === 'string') return input.plan;
  const json = JSON.stringify(input, null, 2);
  return json === '{}' ? '' : json;
}

function QuestionForm({ p }: { p: PermissionRequest }) {
  const t = useTheme();
  const questions = (p.input.questions as Question[]) ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const complete = questions.every((q) => (picked[q.question] ?? []).length > 0);

  const toggle = (q: Question, label: string) => {
    setPicked((prev) => {
      const cur = prev[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...prev, [q.question]: next };
    });
  };

  return (
    <View style={{ gap: 12 }}>
      {questions.map((q) => (
        <View key={q.question} style={{ gap: 6 }}>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '600', lineHeight: 21 }}>{q.question}</Text>
          {q.options.map((o) => {
            const on = (picked[q.question] ?? []).includes(o.label);
            return (
              <Pressable
                key={o.label}
                onPress={() => toggle(q, o.label)}
                accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: on }}
                style={[styles.option, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.surfaceAlt : 'transparent' }]}
              >
                <Text style={{ color: t.text, fontSize: 14.5, fontWeight: '600' }}>{o.label}</Text>
                {!!o.description && <Text style={{ color: t.textMuted, fontSize: 13, lineHeight: 18 }}>{o.description}</Text>}
              </Pressable>
            );
          })}
        </View>
      ))}
      <View style={styles.actions}>
        <Button label="Skip" small onPress={() => bridge.answerPermission(p.requestId, 'deny', { message: 'The user skipped the question.' })} />
        <Button
          label="Send answer"
          variant="primary"
          small
          disabled={!complete}
          onPress={() => {
            const answers: Record<string, string> = {};
            for (const q of questions) answers[q.question] = (picked[q.question] ?? []).join(', ');
            bridge.answerPermission(p.requestId, 'allow', { answers });
          }}
        />
      </View>
    </View>
  );
}

type Props = {
  p: PermissionRequest;
  /** Shown on the session list, where the card is outside its chat. */
  sessionTitle?: string;
  onOpen?: () => void;
};

/** A request from Claude that waits for the user: a permission or a question. */
export function PermissionCard({ p, sessionTitle, onOpen }: Props) {
  const t = useTheme();
  const isQuestion = p.toolName === 'AskUserQuestion' && Array.isArray(p.input.questions);
  const detail = detailOf(p);
  const compact = !!sessionTitle;

  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.accent }]} accessibilityRole="alert">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, color: t.accent, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          {isQuestion ? 'Claude has a question' : p.source === 'desktop' ? 'Permission needed · session on the computer' : 'Permission needed'}
        </Text>
        {!!onOpen && (
          <Pressable onPress={onOpen} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Open session ${sessionTitle}`}>
            <Text style={{ color: t.textSecondary, fontSize: 13, fontWeight: '600' }}>Open session ›</Text>
          </Pressable>
        )}
      </View>
      {!!sessionTitle && (
        <Text numberOfLines={1} style={{ color: t.textMuted, fontSize: 12.5 }}>
          {sessionTitle}
        </Text>
      )}
      {isQuestion && compact ? (
        <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
          {((p.input.questions as Question[]) ?? []).map((q) => q.question).join('\n')}
        </Text>
      ) : isQuestion ? (
        <QuestionForm p={p} />
      ) : (
        <>
          <Text style={{ color: t.text, fontSize: 15.5, fontWeight: '600', lineHeight: 22 }}>
            {p.title || `Claude wants to use ${p.displayName || p.toolName}`}
          </Text>
          {!!p.description && (!compact || p.source === 'desktop') && (
            <Text style={{ color: t.textSecondary, fontSize: 13.5, lineHeight: 19 }}>{p.description}</Text>
          )}
          {!!detail && (
            <ScrollView style={[styles.detail, compact && { maxHeight: 64 }, { backgroundColor: t.codeBg }]} nestedScrollEnabled>
              <Text selectable style={{ fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: t.text }}>
                {detail}
              </Text>
            </ScrollView>
          )}
          <View style={styles.actions}>
            <Button label="Deny" small onPress={() => bridge.answerPermission(p.requestId, 'deny')} />
            {p.canAlways && !compact && (
              <Button label="Always allow" small onPress={() => bridge.answerPermission(p.requestId, 'allow_always')} />
            )}
            <Button label="Allow once" variant="primary" small onPress={() => bridge.answerPermission(p.requestId, 'allow')} />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  detail: { maxHeight: 150, borderRadius: 8, padding: 10 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, gap: 2 },
});

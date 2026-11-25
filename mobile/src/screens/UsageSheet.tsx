import React, { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Sheet } from '../components/ui';
import type { Window } from '../protocol';
import { bridge, useApp } from '../store';
import { useTheme } from '../theme';
import { resetLabel } from '../util';

function Meter({ label, w }: { label: string; w: Window | null | undefined }) {
  const t = useTheme();
  if (!w || typeof w.utilization !== 'number') return null;
  const pct = Math.round(w.utilization);
  const color = pct >= 90 ? t.danger : pct >= 70 ? t.warn : t.accent;
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '600', flex: 1 }}>{label}</Text>
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{pct}% used</Text>
      </View>
      <View
        style={[styles.track, { backgroundColor: t.surfaceAlt }]}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: pct }}
      >
        <View style={{ width: `${Math.min(100, Math.max(1, pct))}%`, height: '100%', borderRadius: 4, backgroundColor: color }} />
      </View>
      <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{resetLabel(w.resets_at) || ' '}</Text>
    </View>
  );
}

export function UsageSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const app = useApp();
  const u = app.usage;
  const rl = u?.rateLimits;

  useEffect(() => {
    if (visible) bridge.refreshUsage();
  }, [visible]);

  const extra = rl?.extra_usage;
  return (
    <Sheet visible={visible} onClose={onClose} title="Usage limits" tall>
      <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 12 }}>
        {!!u?.subscriptionType && (
          <Text style={{ color: t.textSecondary, fontSize: 14 }}>
            Plan: <Text style={{ fontWeight: '700', textTransform: 'capitalize' }}>{u.subscriptionType}</Text>
          </Text>
        )}
        {app.usageLoading && !u && <Text style={{ color: t.textMuted, fontSize: 14 }}>Loading usage…</Text>}
        {!!app.usageError && (
          <Text style={{ color: t.danger, fontSize: 14, lineHeight: 20 }}>Could not load usage: {app.usageError}</Text>
        )}
        {u && !u.rateLimitsAvailable && (
          <Text style={{ color: t.textSecondary, fontSize: 14.5, lineHeight: 21 }}>
            Plan limits are not available for this computer's sign-in. They show for Claude subscription accounts
            (Pro, Max, Team, Enterprise); API-key sessions are billed per token instead, and each reply in a chat shows
            its token count and cost.
          </Text>
        )}
        <Meter label="Current session (5 hours)" w={rl?.five_hour} />
        <Meter label="Weekly, all models" w={rl?.seven_day} />
        {rl?.model_scoped?.map((m) => <Meter key={m.display_name} label={`Weekly, ${m.display_name}`} w={m} />)}
        {!rl?.model_scoped?.length && (
          <>
            <Meter label="Weekly, Opus" w={rl?.seven_day_opus} />
            <Meter label="Weekly, Sonnet" w={rl?.seven_day_sonnet} />
          </>
        )}
        {extra?.is_enabled && typeof extra.utilization === 'number' && (
          <Meter label="Extra usage this month" w={{ utilization: extra.utilization, resets_at: null }} />
        )}
        {app.rateLimit && app.rateLimit.status !== 'allowed' && (
          <Text style={{ color: app.rateLimit.status === 'rejected' ? t.danger : t.warn, fontSize: 14, lineHeight: 20 }}>
            {app.rateLimit.status === 'rejected' ? 'A limit has been reached.' : 'You are close to a limit.'}
            {app.rateLimit.resetsAt ? ` ${resetLabel(new Date(app.rateLimit.resetsAt * 1000).toISOString())}.` : ''}
          </Text>
        )}
        <Button label={app.usageLoading ? 'Refreshing…' : 'Refresh'} disabled={app.usageLoading} onPress={() => bridge.refreshUsage()} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 10 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
});

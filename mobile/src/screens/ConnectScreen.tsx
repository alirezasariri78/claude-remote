import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Field, KeyboardView, Label } from '../components/ui';
import { bridge, useApp } from '../store';
import { serif, useTheme } from '../theme';

export function ConnectScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const app = useApp();
  const [address, setAddress] = useState(app.address);
  const [token, setToken] = useState('');
  const connecting = app.status === 'connecting';

  return (
    <KeyboardView style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.wrap, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}
      >
        <Text style={{ color: t.accent, fontSize: 30, textAlign: 'center' }}>✳</Text>
        <Text style={{ color: t.text, fontFamily: serif, fontSize: 30, fontWeight: '600', textAlign: 'center', marginTop: 6 }}>
          Claude Remote
        </Text>
        <Text style={{ color: t.textMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 8, marginBottom: 28 }}>
          Connect to the Claude Remote service on your computer.
        </Text>

        <Label>Computer address</Label>
        <Field
          value={address}
          onChangeText={setAddress}
          placeholder="192.168.1.10:8787"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Computer address"
        />
        <View style={{ height: 14 }} />
        <Label>Access token</Label>
        <Field
          value={token}
          onChangeText={setToken}
          placeholder="From bridge-config.json on the computer"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="Access token"
        />
        {!!app.error && (
          <Text style={{ color: t.danger, fontSize: 14, lineHeight: 20, marginTop: 12 }} accessibilityRole="alert">
            {app.error}
          </Text>
        )}
        <Button
          label={connecting ? 'Connecting…' : 'Connect'}
          variant="primary"
          disabled={connecting || !address.trim() || !token.trim()}
          onPress={() => bridge.connect(address, token)}
          style={{ marginTop: 20 }}
        />
        <Text style={{ color: t.textMuted, fontSize: 13, lineHeight: 19, marginTop: 18, textAlign: 'center' }}>
          The phone and the computer must be on the same network, or both on a private network such as Tailscale.
        </Text>
      </ScrollView>
    </KeyboardView>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 24, maxWidth: 460, width: '100%', alignSelf: 'center' },
});

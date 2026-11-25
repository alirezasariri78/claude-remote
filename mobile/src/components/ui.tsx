import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardInset } from '../keyboard';
import { useTheme } from '../theme';

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  style?: ViewStyle;
  small?: boolean;
};

export function Button({ label, onPress, variant = 'secondary', disabled, style, small }: ButtonProps) {
  const t = useTheme();
  const bg =
    variant === 'primary' ? t.accent : variant === 'danger' ? 'transparent' : variant === 'ghost' ? 'transparent' : t.surfaceAlt;
  const color = variant === 'primary' ? t.accentText : variant === 'danger' ? t.danger : t.text;
  const borderColor = variant === 'danger' ? t.danger : variant === 'ghost' ? 'transparent' : variant === 'primary' ? t.accent : t.border;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, borderColor, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
        style,
      ]}
    >
      <Text numberOfLines={1} style={{ color, fontSize: small ? 13.5 : 15, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.textMuted}
      {...props}
      style={[styles.field, { backgroundColor: t.surface, borderColor: t.border, color: t.text }, props.style]}
    />
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.label, { color: t.textMuted }]}>{children}</Text>;
}

/**
 * A container that keeps its content above the on-screen keyboard.
 * Native: both iOS and Android need a `behavior`; with Android's edge-to-edge
 * layout the system no longer resizes the window by itself.
 * Web: phone browsers do not resize the page either, so pad by the covered height.
 */
export function KeyboardView({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const inset = useKeyboardInset();
  if (Platform.OS === 'web') return <View style={[style, inset ? { paddingBottom: inset } : null]}>{children}</View>;
  return (
    <KeyboardAvoidingView behavior="padding" style={style}>
      {children}
    </KeyboardAvoidingView>
  );
}

/** Bottom sheet on phones, centered card on wide screens. */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  tall,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  tall?: boolean;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardView style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View
          style={[
            styles.sheet,
            tall && { height: '88%' },
            { backgroundColor: t.bg, borderColor: t.border, paddingBottom: Math.max(insets.bottom, 16) },
          ]}
        >
          <View style={styles.sheetHead}>
            <Text style={{ color: t.text, fontSize: 17, fontWeight: '700', flex: 1 }}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={{ color: t.textMuted, fontSize: 15, fontWeight: '600' }}>Close</Text>
            </Pressable>
          </View>
          {children}
        </View>
      </KeyboardView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSmall: { minHeight: 36, paddingHorizontal: 12, borderRadius: 8 },
  field: { minHeight: 46, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15.5 },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end', alignItems: 'center' },
  sheet: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '92%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
});

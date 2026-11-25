import { Platform, useColorScheme } from 'react-native';

export type Theme = {
  dark: boolean;
  bg: string;
  sidebar: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentText: string;
  danger: string;
  warn: string;
  ok: string;
  codeBg: string;
};

const dark: Theme = {
  dark: true,
  bg: '#262624',
  sidebar: '#1F1E1D',
  surface: '#30302E',
  surfaceAlt: '#3A3A37',
  border: '#45443F',
  text: '#FAF9F5',
  textSecondary: '#C2C0B6',
  textMuted: '#9C9A92',
  accent: '#D97757',
  accentText: '#FFFFFF',
  danger: '#E5766A',
  warn: '#E0A84A',
  ok: '#7DB78A',
  codeBg: '#1B1B19',
};

const light: Theme = {
  dark: false,
  bg: '#FAF9F5',
  sidebar: '#F0EEE6',
  surface: '#FFFFFF',
  surfaceAlt: '#F0EEE6',
  border: '#DDDAD0',
  text: '#141413',
  textSecondary: '#3D3D3A',
  textMuted: '#73726C',
  accent: '#C96442',
  accentText: '#FFFFFF',
  danger: '#B53333',
  warn: '#A16207',
  ok: '#2F7D4A',
  codeBg: '#F0EEE6',
};

export function useTheme(): Theme {
  return useColorScheme() === 'light' ? light : dark;
}

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Consolas, Menlo, monospace' });
export const serif = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, "Times New Roman", serif' });

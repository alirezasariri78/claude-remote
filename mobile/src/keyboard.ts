// Keeping content above the on-screen keyboard.
//
// Native: KeyboardView (components/ui.tsx) uses KeyboardAvoidingView.
// Web: browsers on phones do not shrink the page when the keyboard opens; they
// only shrink the "visual viewport". These helpers measure the covered height
// so the layout can make room for it.

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined';

// Smaller changes are the browser's address bar sliding, not a keyboard.
const MIN_KEYBOARD = 80;

/**
 * Web only: ask the browser to shrink the page itself when the keyboard opens
 * (Chrome on Android honors this; then the measured inset below stays 0).
 */
export function setupViewport() {
  if (!isWeb) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const content = meta.getAttribute('content') ?? '';
  if (content.includes('interactive-widget')) return;
  meta.setAttribute('content', `${content}, interactive-widget=resizes-content`);
}

function coveredHeight(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const covered = Math.round(window.innerHeight - vv.height - vv.offsetTop);
  return covered >= MIN_KEYBOARD ? covered : 0;
}

/** Web: height of the page currently hidden by the keyboard. Native: always 0. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!isWeb || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => {
      const next = coveredHeight();
      setInset(next);
      // iOS Safari scrolls the whole page up when an input is focused; undo it,
      // since the layout now makes the room itself.
      if (next > 0 && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

/** True while the on-screen keyboard is open. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (isWeb) {
      const vv = window.visualViewport;
      if (!vv) return;
      // Covers both cases: the page shrank (Android) or only the visual viewport did (iOS).
      const full = Math.max(window.innerHeight, vv.height);
      const update = () => setVisible(full - vv.height >= MIN_KEYBOARD);
      vv.addEventListener('resize', update);
      return () => vv.removeEventListener('resize', update);
    }
    const show = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

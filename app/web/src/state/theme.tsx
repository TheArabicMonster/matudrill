import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  applyTheme,
  getThemeStorage,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  toggleTheme,
  writeThemePreference,
} from '../lib/theme';
import type { ResolvedTheme, ThemePreference } from '../lib/theme';

interface ThemeState {
  preference: ThemePreference;
  theme: ResolvedTheme;
}

interface ThemeValue extends ThemeState {
  /** Bascule clair ↔ sombre et enregistre la préférence explicite. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function systemMedia(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia('(prefers-color-scheme: dark)');
}

/** Thème déjà posé par le script inline de index.html. */
function appliedTheme(): ResolvedTheme | null {
  if (typeof document === 'undefined') return null;
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'light' || value === 'dark' ? value : null;
}

function initialState(): ThemeState {
  const preference = readThemePreference(getThemeStorage());
  const theme = appliedTheme() ?? resolveTheme(preference, systemMedia()?.matches === true);
  return { preference, theme };
}

let transitionTimer: number | undefined;

/** Classe temporaire : la transition de 150 ms ne joue qu'au clic. */
function animateThemeChange() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.add('theme-transition');
  if (transitionTimer !== undefined) window.clearTimeout(transitionTimer);
  transitionTimer = window.setTimeout(() => {
    root.classList.remove('theme-transition');
    transitionTimer = undefined;
  }, 200);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThemeState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    applyTheme(state.theme);
  }, [state.theme]);

  // `system` suit le réglage de l'OS en direct.
  useEffect(() => {
    const media = systemMedia();
    if (!media) return;
    function onChange(event: MediaQueryListEvent) {
      if (stateRef.current.preference !== 'system') return;
      const next: ResolvedTheme = event.matches ? 'dark' : 'light';
      applyTheme(next);
      setState((current) => (current.preference === 'system' ? { ...current, theme: next } : current));
    }
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Un autre onglet a changé la préférence : on suit.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== THEME_STORAGE_KEY) return;
      const preference = readThemePreference(getThemeStorage());
      const theme = resolveTheme(preference, systemMedia()?.matches === true);
      applyTheme(theme);
      setState({ preference, theme });
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback(() => {
    const next = toggleTheme(stateRef.current.theme);
    animateThemeChange();
    applyTheme(next);
    writeThemePreference(next, getThemeStorage());
    stateRef.current = { preference: next, theme: next };
    setState({ preference: next, theme: next });
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ theme: state.theme, preference: state.preference, toggle }),
    [state.theme, state.preference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme doit être utilisé dans ThemeProvider.');
  return value;
}

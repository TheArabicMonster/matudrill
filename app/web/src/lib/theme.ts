/**
 * Préférence de thème : `system` suit `prefers-color-scheme`, un clic fixe
 * `light` ou `dark`. Aucune de ces fonctions ne lève si localStorage est
 * indisponible (navigation privée, iframe, quota).
 */

export const THEME_STORAGE_KEY = 'matudrill-theme';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Valeur enregistrée ; toute valeur absente ou invalide vaut `system`. */
export function readThemePreference(storage: ThemeStorage | null | undefined): ThemePreference {
  if (!storage) return 'system';
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* La préférence n'est pas enregistrée, le thème reste appliqué. */
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

export function toggleTheme(theme: ResolvedTheme): ResolvedTheme {
  return theme === 'dark' ? 'light' : 'dark';
}

export function applyTheme(
  theme: ResolvedTheme,
  root: Pick<HTMLElement, 'setAttribute'> | null = typeof document === 'undefined'
    ? null
    : document.documentElement,
): void {
  root?.setAttribute('data-theme', theme);
}

/** `window.localStorage` peut lever à la simple lecture de la propriété. */
export function getThemeStorage(): ThemeStorage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

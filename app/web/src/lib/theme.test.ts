import { describe, expect, it, vi } from 'vitest';

import {
  applyTheme,
  getThemeStorage,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  toggleTheme,
  writeThemePreference,
  type ThemeStorage,
} from './theme';

function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] ?? null : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe('préférence de thème', () => {
  it('suit le système par défaut, sans valeur enregistrée', () => {
    expect(readThemePreference(null)).toBe('system');
    expect(readThemePreference(memoryStorage())).toBe('system');
  });

  it('lit une valeur explicite enregistrée', () => {
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark');
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light');
  });

  it('ramène une valeur invalide à system', () => {
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'sepia' }))).toBe('system');
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: '' }))).toBe('system');
  });

  it('résout system en sombre quand le média préfère le sombre', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('garde la préférence explicite quand le système change', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('fixe une préférence explicite au clic, qui ne dépend plus du système', () => {
    const storage = memoryStorage();
    const before = resolveTheme(readThemePreference(storage), true);
    expect(before).toBe('dark');

    const after = toggleTheme(before);
    writeThemePreference(after, storage);

    expect(after).toBe('light');
    expect(readThemePreference(storage)).toBe('light');
    expect(resolveTheme(readThemePreference(storage), true)).toBe('light');
    expect(resolveTheme(readThemePreference(storage), false)).toBe('light');
  });

  it('ne lève pas quand localStorage est indisponible', () => {
    const throwing: ThemeStorage = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
    };

    expect(() => readThemePreference(throwing)).not.toThrow();
    expect(readThemePreference(throwing)).toBe('system');
    expect(() => writeThemePreference('dark', throwing)).not.toThrow();
  });

  it('retombe sur system quand la propriété localStorage lève', () => {
    // Vitest tourne sans `window` : getThemeStorage ne doit pas lever.
    expect(() => getThemeStorage()).not.toThrow();
    expect(getThemeStorage()).toBeNull();
    expect(readThemePreference(getThemeStorage())).toBe('system');
  });

  it('ne lève pas quand window.localStorage est inaccessible', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(() => getThemeStorage()).not.toThrow();
      expect(getThemeStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pose data-theme sur la racine', () => {
    const root = { setAttribute: vi.fn() };
    applyTheme('dark', root);
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
  });
});

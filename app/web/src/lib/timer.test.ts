import { describe, expect, it } from 'vitest';

import {
  clockElapsed,
  clockFrom,
  clockHalt,
  clockRun,
  formatDuration,
  formatTimer,
  isPaused,
  readTimerVisible,
  TIMER_RUNNING,
  toggleUserPause,
  withEditorOpen,
  withTabHidden,
  writeTimerVisible,
} from './timer';

describe('formatTimer', () => {
  it('affiche m:ss puis h:mm:ss au-delà d’une heure', () => {
    expect(formatTimer(0)).toBe('0:00');
    expect(formatTimer(65_000)).toBe('1:05');
    expect(formatTimer(3_723_000)).toBe('1:02:03');
    expect(formatTimer(59_999)).toBe('0:59');
    expect(formatTimer(600_000)).toBe('10:00');
    // Une valeur négative (horloge qui recule) ne casse pas l'affichage.
    expect(formatTimer(-1_000)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  it('écrit les durées en toutes lettres', () => {
    expect(formatDuration(271_000)).toBe('4 min 31 s');
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(31_000)).toBe('31 s');
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(3_723_000)).toBe('1 h 02 min');
    expect(formatDuration(3_600_000)).toBe('1 h');
  });
});

describe('logique de pause', () => {
  it('ne s’arrête qu’avec une cause, et la pause manuelle prime', () => {
    expect(isPaused(TIMER_RUNNING)).toBe(false);

    const byUser = toggleUserPause(TIMER_RUNNING);
    expect(byUser.userPaused).toBe(true);
    expect(isPaused(byUser)).toBe(true);

    // L'onglet devient caché puis revient : la pause manuelle tient.
    const hidden = withTabHidden(byUser, true);
    expect(isPaused(hidden)).toBe(true);
    const visibleAgain = withTabHidden(hidden, false);
    expect(visibleAgain.userPaused).toBe(true);
    expect(isPaused(visibleAgain)).toBe(true);

    // Seul l'utilisateur reprend.
    const resumed = toggleUserPause(visibleAgain);
    expect(isPaused(resumed)).toBe(false);
  });

  it('met en pause automatiquement quand l’onglet est caché ou l’éditeur ouvert', () => {
    const hidden = withTabHidden(TIMER_RUNNING, true);
    expect(isPaused(hidden)).toBe(true);
    expect(isPaused(withTabHidden(hidden, false))).toBe(false);

    const editing = withEditorOpen(TIMER_RUNNING, true);
    expect(isPaused(editing)).toBe(true);
    // Fermer l'éditeur ne reprend pas si l'utilisateur avait mis en pause.
    const paused = toggleUserPause(editing);
    expect(isPaused(withEditorOpen(paused, false))).toBe(true);
  });

  it('ne crée pas de nouvel état quand rien ne change', () => {
    expect(withTabHidden(TIMER_RUNNING, false)).toBe(TIMER_RUNNING);
    expect(withEditorOpen(TIMER_RUNNING, false)).toBe(TIMER_RUNNING);
  });
});

describe('horloge du chronomètre', () => {
  it('calcule le temps depuis performance.now(), pas par accumulation', () => {
    const clock = clockFrom(10_000, true, 1_000);
    expect(clockElapsed(clock, 1_000)).toBe(10_000);
    expect(clockElapsed(clock, 4_000)).toBe(13_000);

    // Un tick en retard ne perd pas de temps : 10 s réelles = 10 s affichées.
    expect(clockElapsed(clock, 11_000)).toBe(20_000);
  });

  it('fige le temps en pause et repart au même endroit', () => {
    const running = clockFrom(5_000, true, 1_000);
    const halted = clockHalt(running, 3_000);
    expect(halted.startedAt).toBeNull();
    expect(clockElapsed(halted, 60_000)).toBe(7_000);

    const resumed = clockRun(halted, 60_000);
    expect(clockElapsed(resumed, 62_500)).toBe(9_500);
    // Redémarrer une horloge déjà en marche ne change pas son origine.
    expect(clockRun(resumed, 70_000)).toBe(resumed);
  });

  it('démarre en pause quand une cause de pause est active', () => {
    const clock = clockFrom(1_000, false, 0);
    expect(clock.startedAt).toBeNull();
    expect(clockElapsed(clock, 10_000)).toBe(1_000);
  });
});

describe('préférence matudrill-timer-visible', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  }

  it('est visible par défaut et mémorise le masquage', () => {
    const storage = memoryStorage();
    expect(readTimerVisible(storage)).toBe(true);
    writeTimerVisible(false, storage);
    expect(readTimerVisible(storage)).toBe(false);
    writeTimerVisible(true, storage);
    expect(readTimerVisible(storage)).toBe(true);
  });

  it('tolère l’absence de localStorage', () => {
    expect(readTimerVisible(null)).toBe(true);
    expect(() => writeTimerVisible(false, null)).not.toThrow();
  });
});

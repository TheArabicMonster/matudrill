/**
 * Chronomètre par exercice (v1.2) : formatage et logique de pause, sans DOM.
 * Le temps affiché vient toujours d'une horloge `performance.now()` : aucune
 * accumulation de `setInterval` qui dérive.
 */

/** Préférence d'affichage du chronomètre dans la barre de session. */
export const TIMER_STORAGE_KEY = 'matudrill-timer-visible';

/** `m:ss`, ou `h:mm:ss` au-delà d'une heure. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

/** Durée lisible : « 42 s », « 4 min 31 s », « 1 h 04 min ». */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${hours} h`;
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
  return `${seconds} s`;
}

export interface TimerPauseState {
  /** L'utilisateur a appuyé sur pause (ou `T`) : seule lui peut l'annuler. */
  userPaused: boolean;
  /** Onglet caché : pause automatique, reprise au retour. */
  tabHidden: boolean;
  /** Éditeur de recadrage ouvert : pause automatique, reprise à la fermeture. */
  editorOpen: boolean;
}

export const TIMER_RUNNING: TimerPauseState = {
  userPaused: false,
  tabHidden: false,
  editorOpen: false,
};

/** En pause dès qu'une des causes est vraie : la pause manuelle prime. */
export function isPaused(state: TimerPauseState): boolean {
  return state.userPaused || state.tabHidden || state.editorOpen;
}

/** `T` / bouton pause : ne touche qu'à la pause manuelle. */
export function toggleUserPause(state: TimerPauseState): TimerPauseState {
  return { ...state, userPaused: !state.userPaused };
}

/** `visibilitychange` : met en pause, sans annuler la pause manuelle. */
export function withTabHidden(state: TimerPauseState, hidden: boolean): TimerPauseState {
  return state.tabHidden === hidden ? state : { ...state, tabHidden: hidden };
}

/** Ouverture / fermeture de l'éditeur de recadrage. */
export function withEditorOpen(state: TimerPauseState, open: boolean): TimerPauseState {
  return state.editorOpen === open ? state : { ...state, editorOpen: open };
}

export interface TimerClock {
  /** Millisecondes acquises avant le segment en cours. */
  accumulatedMs: number;
  /** Origine `performance.now()` du segment en cours, `null` en pause. */
  startedAt: number | null;
}

export function clockFrom(accumulatedMs: number, running: boolean, now: number): TimerClock {
  return { accumulatedMs: Math.max(0, accumulatedMs), startedAt: running ? now : null };
}

/** Temps courant du chronomètre, dérivé de l'origine — jamais accumulé. */
export function clockElapsed(clock: TimerClock, now: number): number {
  const segment = clock.startedAt === null ? 0 : Math.max(0, now - clock.startedAt);
  return clock.accumulatedMs + segment;
}

/** Démarre le segment en cours (sans effet s'il tourne déjà). */
export function clockRun(clock: TimerClock, now: number): TimerClock {
  return clock.startedAt === null ? { ...clock, startedAt: now } : clock;
}

/** Fige le temps acquis et arrête le segment en cours. */
export function clockHalt(clock: TimerClock, now: number): TimerClock {
  return { accumulatedMs: clockElapsed(clock, now), startedAt: null };
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Défaut : visible. Seul `0` masque le chronomètre. */
export function readTimerVisible(storage: PreferenceStorage | null): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(TIMER_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeTimerVisible(visible: boolean, storage: PreferenceStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(TIMER_STORAGE_KEY, visible ? '1' : '0');
  } catch {
    /* navigation privée : la préférence ne survit pas, ce n'est pas grave */
  }
}

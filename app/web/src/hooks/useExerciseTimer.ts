import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, sendTime } from '../api';
import {
  clockElapsed,
  clockFrom,
  clockHalt,
  clockRun,
  isPaused,
  readTimerVisible,
  TIMER_RUNNING,
  toggleUserPause,
  withEditorOpen,
  withTabHidden,
  writeTimerVisible,
} from '../lib/timer';

/** Envoi périodique du temps cumulé, spec v1.2. */
const FLUSH_EVERY_MS = 15_000;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function preferenceStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface ExerciseTimer {
  /** Temps cumulé affiché pour l'exercice courant. */
  elapsedMs: number;
  paused: boolean;
  /** Préférence `matudrill-timer-visible`. */
  visible: boolean;
  togglePause: () => void;
  toggleVisible: () => void;
  /** Envoie le temps courant au serveur (avant de terminer la session). */
  flush: () => Promise<void>;
}

/**
 * Chronomètre d'un exercice de session. Repart du temps déjà enregistré côté
 * serveur, se met en pause quand l'onglet est caché ou l'éditeur de recadrage
 * ouvert, et envoie le cumul toutes les 15 s, au changement d'exercice et au
 * `pagehide`.
 */
export function useExerciseTimer(options: {
  sessionId: string;
  exerciseId: string | null;
  /** Temps déjà enregistré pour cet exercice (session rechargée). */
  initialElapsedMs: number;
  /** L'éditeur de recadrage est ouvert : le chronomètre se met en pause. */
  editorOpen: boolean;
}): ExerciseTimer {
  const { sessionId, exerciseId, initialElapsedMs, editorOpen } = options;

  const [pause, setPause] = useState(TIMER_RUNNING);
  const [elapsedMs, setElapsedMs] = useState(Math.max(0, initialElapsedMs));
  const [visible, setVisible] = useState(() => readTimerVisible(preferenceStorage()));

  const pauseRef = useRef(pause);
  pauseRef.current = pause;

  const clockRef = useRef(clockFrom(initialElapsedMs, false, 0));
  const exerciseRef = useRef<string | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  /** Dernier temps envoyé au serveur, pour ne pas répéter la même valeur. */
  const sentRef = useRef(Math.max(0, initialElapsedMs));
  /** Temps acquis par exercice, si on revient dessus sans recharger. */
  const knownRef = useRef(new Map<string, number>());

  const paused = isPaused(pause);

  // `aria-live="off"` côté écran : l'affichage suit l'horloge, pas les ticks.
  const refresh = useCallback(() => {
    setElapsedMs(Math.round(clockElapsed(clockRef.current, now())));
  }, []);

  /** Envoie le temps courant ; `keepalive` pour `pagehide` et le démontage. */
  const push = useCallback((keepalive = false): Promise<void> => {
    const exercise = exerciseRef.current;
    if (!exercise) return Promise.resolve();
    const value = Math.round(clockElapsed(clockRef.current, now()));
    if (value === sentRef.current) return Promise.resolve();
    knownRef.current.set(exercise, value);

    if (keepalive) {
      sentRef.current = value;
      sendTime(sessionRef.current, exercise, value);
      return Promise.resolve();
    }
    return api
      .putTime(sessionRef.current, exercise, value)
      .then(() => {
        sentRef.current = value;
      })
      .catch(() => {
        // Le prochain envoi (15 s, changement d'exercice) réessaiera.
      });
  }, []);

  // Nouvel exercice : on repart du temps du serveur (ou du temps local connu).
  useEffect(() => {
    if (!exerciseId) {
      exerciseRef.current = null;
      return;
    }
    const known = knownRef.current.get(exerciseId) ?? 0;
    const start = Math.max(0, initialElapsedMs, known);
    clockRef.current = clockFrom(start, !isPaused(pauseRef.current), now());
    exerciseRef.current = exerciseId;
    sentRef.current = start;
    setElapsedMs(start);

    return () => {
      // On quitte l'exercice : on enregistre le temps acquis.
      const value = Math.round(clockElapsed(clockRef.current, now()));
      knownRef.current.set(exerciseId, value);
      if (exerciseRef.current === exerciseId) exerciseRef.current = null;
      if (value !== sentRef.current) {
        sentRef.current = value;
        sendTime(sessionRef.current, exerciseId, value);
      }
    };
  }, [exerciseId, initialElapsedMs]);

  // Pause / reprise : on fige ou redémarre l'horloge, jamais les ticks.
  useEffect(() => {
    const current = now();
    clockRef.current = paused ? clockHalt(clockRef.current, current) : clockRun(clockRef.current, current);
    setElapsedMs(Math.round(clockElapsed(clockRef.current, current)));
  }, [paused]);

  useEffect(() => {
    setPause((current) => withEditorOpen(current, editorOpen));
  }, [editorOpen]);

  // Affichage : un réveil par seconde, mais le temps vient de performance.now().
  useEffect(() => {
    if (!exerciseId) return;
    const id = window.setInterval(() => {
      if (isPaused(pauseRef.current)) return;
      refresh();
    }, 1000);
    return () => window.clearInterval(id);
  }, [exerciseId, refresh]);

  // Envoi périodique (15 s) pendant que le chronomètre tourne.
  useEffect(() => {
    if (!exerciseId) return;
    const id = window.setInterval(() => {
      if (isPaused(pauseRef.current)) return;
      void push();
    }, FLUSH_EVERY_MS);
    return () => window.clearInterval(id);
  }, [exerciseId, push]);

  // Onglet caché : pause automatique, et on profite du passage pour enregistrer.
  useEffect(() => {
    function onVisibility() {
      const hidden = document.visibilityState === 'hidden';
      setPause((current) => withTabHidden(current, hidden));
      if (hidden) void push(true);
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [push]);

  // Fermeture / rechargement : dernière chance d'envoyer le temps.
  useEffect(() => {
    function onPageHide() {
      void push(true);
    }
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [push]);

  const togglePause = useCallback(() => setPause(toggleUserPause), []);

  const toggleVisible = useCallback(() => {
    setVisible((current) => {
      const next = !current;
      writeTimerVisible(next, preferenceStorage());
      return next;
    });
  }, []);

  return useMemo(
    () => ({ elapsedMs, paused, visible, togglePause, toggleVisible, flush: push }),
    [elapsedMs, paused, visible, togglePause, toggleVisible, push],
  );
}

import { EyeOff, Pause, Play, Timer } from 'lucide-react';
import { useId } from 'react';

import u from '../../components/ui.module.css';
import { cx } from '../../lib/cx';
import { formatDuration, formatTimer } from '../../lib/timer';
import s from './SessionPage.module.css';

/**
 * Chronomètre de la barre de session : valeur `m:ss`, bouton pause/reprise et
 * masquage mémorisé. Les secondes ne sont jamais annoncées (`aria-live="off"`) ;
 * le temps se lit à la demande, en focus sur un bouton (`aria-describedby`).
 */
export function TimerControl({
  elapsedMs,
  paused,
  visible,
  onTogglePause,
  onToggleVisible,
}: {
  elapsedMs: number;
  paused: boolean;
  visible: boolean;
  onTogglePause: () => void;
  onToggleVisible: () => void;
}) {
  const timeId = useId();
  const readout = formatTimer(elapsedMs);
  const spoken = formatDuration(elapsedMs);

  const timeDescription = (
    <span id={timeId} className="visually-hidden" aria-live="off">
      Temps écoulé sur cet exercice : {spoken}.
    </span>
  );

  if (!visible) {
    return (
      <span className={s.timer}>
        {timeDescription}
        <button
          type="button"
          className={cx(u.btn, u.ghost, u.iconOnly)}
          onClick={onToggleVisible}
          aria-label="Afficher le chronomètre"
          aria-describedby={timeId}
          title={`Afficher le chronomètre (${readout})`}
        >
          <Timer size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </span>
    );
  }

  return (
    <span className={cx(s.timer, paused && s.timerPaused)}>
      {timeDescription}
      <span className={s.timerClock} role="timer" aria-live="off">
        <Timer size={16} strokeWidth={2} aria-hidden="true" />
        <span className={s.timerValue}>{readout}</span>
      </span>
      {paused ? <span className={s.timerState}>En pause</span> : null}
      <button
        type="button"
        className={cx(u.btn, u.ghost, u.iconOnly)}
        onClick={onTogglePause}
        aria-label={paused ? 'Reprendre le chronomètre' : 'Mettre le chronomètre en pause'}
        aria-describedby={timeId}
        aria-pressed={paused}
        title={`${paused ? 'Reprendre' : 'Mettre en pause'} le chronomètre (T)`}
      >
        {paused ? (
          <Play size={18} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Pause size={18} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className={cx(u.btn, u.ghost, u.iconOnly, s.timerHide)}
        onClick={onToggleVisible}
        aria-label="Masquer le chronomètre"
        title="Masquer le chronomètre"
      >
        <EyeOff size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </span>
  );
}

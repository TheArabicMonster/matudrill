import { GripVertical, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';

import { Kbd, Segmented } from '../../components/ui';
import u from '../../components/ui.module.css';
import { cx } from '../../lib/cx';
import { useCart } from '../../state/cart';
import type { Catalog, SessionMode } from '../../types';
import s from './SessionCart.module.css';

const MODE_OPTIONS: { value: SessionMode; label: string }[] = [
  { value: 'step', label: 'Pas à pas' },
  { value: 'all', label: 'Tout afficher' },
];

export function SessionCart({
  catalog,
  onStart,
  starting,
  startError,
  variant = 'column',
  onClose,
}: {
  catalog: Catalog;
  onStart: () => void;
  starting: boolean;
  startError: string | null;
  variant?: 'column' | 'drawer';
  onClose?: () => void;
}) {
  const { items, mode, setMode, removeExercise, togglePart, clear, move, count, partCount } = useCart();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const headingId = useId();

  const exercises = new Map(catalog.exercises.map((exercise) => [exercise.id, exercise]));
  const rows = items.flatMap((item) => {
    const exercise = exercises.get(item.exerciseId);
    return exercise ? [{ item, exercise }] : [];
  });

  function announcePosition(index: number) {
    const row = rows[index];
    if (!row) return;
    setNotice(`Exercice ${row.exercise.number} déplacé en position ${index + 1} sur ${rows.length}.`);
  }

  function handleMove(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    move(index, target);
    announcePosition(target);
  }

  return (
    <section className={cx(s.cart, variant === 'drawer' && s.drawer)} aria-labelledby={headingId}>
      <header className={s.head}>
        <h2 id={headingId} className={s.title}>
          Session
        </h2>
        <div className={s.headActions}>
          <button
            type="button"
            className={cx(u.btn, u.ghost)}
            onClick={clear}
            disabled={count === 0}
          >
            <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
            Vider
          </button>
          {variant === 'drawer' && onClose ? (
            <button
              type="button"
              className={cx(u.btn, u.ghost, u.iconOnly)}
              onClick={onClose}
              aria-label="Fermer la session"
            >
              <X size={20} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <div className={s.items} role="list">
        {rows.length === 0 ? (
          <div className={s.empty}>
            <p className={s.emptyTitle}>Aucun exercice dans la session</p>
            <p className={s.emptyText}>Coche un exercice dans la liste pour l’enchaîner ici.</p>
            <p className={s.emptyText}>
              Tu peux aussi taper ses numéros dans « Ajouter par numéro », au-dessus de la liste.
            </p>
          </div>
        ) : (
          rows.map(({ exercise, item }, index) => (
            <div
              key={exercise.id}
              role="listitem"
              className={cx(s.item, dragIndex === index && s.dragging)}
              draggable
              onDragStart={(event) => {
                setDragIndex(index);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', exercise.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIndex !== null && dragIndex !== index) {
                  move(dragIndex, index);
                  announcePosition(index);
                }
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
            >
              <div className={s.itemTop}>
                <button
                  type="button"
                  className={s.handle}
                  aria-label={`Déplacer l’exercice ${exercise.number} dans la session`}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      handleMove(index, -1);
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      handleMove(index, 1);
                    }
                  }}
                >
                  <GripVertical size={16} strokeWidth={2} aria-hidden="true" />
                </button>
                <span className={s.itemTitle}>Exercice {exercise.number}</span>
                {exercise.title ? <span className={s.itemSubtitle}>{exercise.title}</span> : null}
                <span className={s.itemPage}>{exercise.pages.length > 0 ? `p. ${exercise.pages[0]}` : ''}</span>
                <button
                  type="button"
                  className={cx(u.btn, u.ghost, s.remove)}
                  onClick={() => removeExercise(exercise.id)}
                  aria-label={`Retirer l’exercice ${exercise.number} de la session`}
                >
                  <X size={16} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>

              {exercise.parts.length > 0 ? (
                <div className={s.parts} role="group" aria-label={`Sous-questions de l’exercice ${exercise.number}`}>
                  {exercise.parts.map((part) => (
                    <button
                      key={part.label}
                      type="button"
                      className={s.part}
                      aria-pressed={item.parts.includes(part.label)}
                      aria-label={`Sous-question ${part.label} de l’exercice ${exercise.number}`}
                      onClick={() => togglePart(exercise, part.label)}
                    >
                      {part.label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className={s.global}>Auto-évaluation globale</p>
              )}
            </div>
          ))
        )}
      </div>

      <div className={s.mode}>
        <h3 className={s.modeTitle}>Mode</h3>
        <Segmented
          label="Mode de session"
          options={MODE_OPTIONS}
          value={mode}
          onChange={setMode}
          className={s.modeControl}
        />
        <p className={s.modeText}>
          {mode === 'step'
            ? 'Une sous-question à la fois, solution après chaque réponse.'
            : 'Toutes les sous-questions, solutions révélables une par une.'}
        </p>
      </div>

      <footer className={s.foot}>
        <p className={s.summary}>
          {count} {count > 1 ? 'exercices' : 'exercice'} · {partCount}{' '}
          {partCount > 1 ? 'sous-questions' : 'sous-question'}
        </p>
        <p className={s.note}>Les cases décochées sont ignorées pendant la session.</p>
        <button
          type="button"
          className={cx(u.btn, u.primary, s.start)}
          onClick={onStart}
          disabled={count === 0 || starting}
        >
          {starting ? 'Ouverture…' : startError ? 'Réessayer' : 'Commencer la session'}
          {!starting && !startError ? <Kbd>Entrée</Kbd> : null}
        </button>
        {startError ? (
          <p className={s.error} role="alert">
            {startError}
          </p>
        ) : null}
      </footer>

      <p className="visually-hidden" aria-live="polite">
        {notice}
      </p>
    </section>
  );
}

import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { EditableCrop } from '../../components/EditableCrop';
import { SubjectTag } from '../../components/ui';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import u from '../../components/ui.module.css';
import { cx } from '../../lib/cx';
import { exerciseTitle, formatPages } from '../../lib/format';
import { questionSlot, statementSlot } from '../../lib/slots';
import type { Exercise, Subject } from '../../types';
import s from './PreviewPanel.module.css';

export function PreviewPanel({
  exercise,
  subject,
  subjectName,
  sectionTitle,
  initialParts,
  onAdd,
  onClose,
}: {
  exercise: Exercise;
  subject: Subject;
  subjectName: string;
  sectionTitle: string;
  initialParts: string[];
  onAdd: (parts: string[]) => void;
  onClose: () => void;
}) {
  const [parts, setParts] = useState<string[]>(
    initialParts.length > 0 ? initialParts : exercise.parts.map((part) => part.label),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = `preview-${exercise.id}`;
  const heading = exercise.title
    ? exerciseTitle(exercise)
    : `Exercice ${exercise.number} · ${sectionTitle}`;

  useFocusTrap(true, panelRef);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function toggle(label: string) {
    setParts((current) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    );
  }

  return (
    <div className={s.layer}>
      <div className={s.scrim} aria-hidden="true" onClick={onClose} />
      <div className={s.panel} role="dialog" aria-modal="true" aria-labelledby={headingId} ref={panelRef}>
        <header className={s.head}>
          <h2 id={headingId} className={s.title}>
            {heading}
          </h2>
          <button
            type="button"
            className={cx(u.btn, u.ghost, u.iconOnly)}
            onClick={onClose}
            aria-label="Fermer l’aperçu"
          >
            <X size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <div className={s.body}>
          <div className={s.statement}>
            {exercise.statement.map((crop, index) => (
              <EditableCrop
                key={crop.src}
                exerciseId={exercise.id}
                slot={statementSlot(index)}
                subject={subject}
                crop={crop}
                alt={`Exercice ${exercise.number}, énoncé${exercise.statement.length > 1 ? ` (partie ${index + 1})` : ''}`}
                title={`Énoncé de l’exercice ${exercise.number}`}
                page={crop.page ?? exercise.pages[0] ?? 1}
                scale={0.34}
              />
            ))}
          </div>

          {exercise.parts.length > 0 ? (
            <ul className={s.parts}>
              {exercise.parts.map((part) => (
                <li key={part.label} className={s.part}>
                  <input
                    type="checkbox"
                    className={s.check}
                    checked={parts.includes(part.label)}
                    onChange={() => toggle(part.label)}
                    aria-label={`Inclure la sous-question ${part.label} de l’exercice ${exercise.number}`}
                  />
                  <EditableCrop
                    exerciseId={exercise.id}
                    slot={questionSlot(part.label)}
                    subject={subject}
                    crop={part.question}
                    alt={`Sous-question ${part.label})`}
                    title={`Sous-question ${part.label})`}
                    page={part.question.page ?? exercise.pages[0] ?? 1}
                    scale={0.34}
                    imageClassName={s.partImage}
                    variant="inline"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.single}>Exercice sans sous-question : une seule auto-évaluation globale.</p>
          )}
        </div>

        <footer className={s.foot}>
          <p className={s.meta}>
            {exercise.parts.length > 0
              ? `${exercise.parts.length} ${exercise.parts.length > 1 ? 'sous-questions' : 'sous-question'} · ${formatPages(exercise.pages)}`
              : `Auto-évaluation globale · ${formatPages(exercise.pages)}`}
          </p>
          <div className={s.footActions}>
            <SubjectTag subjectId={exercise.subject} name={subjectName} />
            <button
              type="button"
              className={cx(u.btn, u.accent)}
              onClick={() => onAdd(parts)}
              disabled={exercise.parts.length > 0 && parts.length === 0}
            >
              <Plus size={18} strokeWidth={2} aria-hidden="true" />
              Ajouter à la session
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

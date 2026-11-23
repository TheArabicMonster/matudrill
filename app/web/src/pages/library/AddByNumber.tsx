import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';

import { api } from '../../api';
import { cx } from '../../lib/cx';
import { formatNumberList, plural } from '../../lib/format';
import type { Exercise, UnknownNumber } from '../../types';
import u from '../../components/ui.module.css';
import s from './AddByNumber.module.css';

interface Feedback {
  foundNumbers: string[];
  added: number;
  unknown: UnknownNumber[];
}

export function AddByNumber({
  subjectId,
  subjectName,
  exercises,
  onAdd,
}: {
  subjectId: string | null;
  subjectName: string;
  exercises: Exercise[];
  onAdd: (exercises: Exercise[]) => number;
}) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = !subjectId;

  async function run(raw: string) {
    if (!subjectId || raw.trim().length === 0) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.resolveNumbers({ subject: subjectId, input: raw });
      const found = result.found
        .map((id) => exercises.find((exercise) => exercise.id === id))
        .filter((exercise): exercise is Exercise => exercise !== undefined);
      const added = found.length > 0 ? onAdd(found) : 0;
      setFeedback({
        foundNumbers: found.map((exercise) => exercise.number),
        added,
        unknown: result.unknown,
      });
    } catch (caught) {
      setFeedback(null);
      setError(caught instanceof Error ? caught.message : 'La recherche a échoué. Réessaie.');
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    void run(value);
  }

  function correct(suggestion: string) {
    setValue(suggestion);
    inputRef.current?.focus();
    void run(suggestion);
  }

  return (
    <div className={s.wrap}>
      <form className={s.form} onSubmit={onSubmit}>
        <label className={s.label} htmlFor="add-by-number">
          Ajouter par numéro
        </label>
        <input
          id="add-by-number"
          ref={inputRef}
          className={cx(u.input, s.input)}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="1.3–1.8, 2.4"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        <button type="submit" className={cx(u.btn, u.secondary, s.submit)} disabled={disabled || pending}>
          {pending ? 'Recherche…' : 'Ajouter'}
        </button>
      </form>

      {disabled ? (
        <p className={s.help}>Choisis une matière à gauche pour ajouter par numéro.</p>
      ) : null}

      <div aria-live="polite" className={s.feedback}>
        {error ? (
          <p className={s.line}>
            <TriangleAlert size={16} strokeWidth={2} className={s.warnIcon} aria-hidden="true" />
            {error}
          </p>
        ) : null}

        {feedback ? (
          <>
            {feedback.foundNumbers.length > 0 ? (
              <p className={cx(s.line, s.ok)}>
                <CheckCircle2 size={16} strokeWidth={2} className={s.okIcon} aria-hidden="true" />
                {feedback.added > 0
                  ? `${feedback.added} ${plural(feedback.added, 'exercice ajouté', 'exercices ajoutés')} à la session : ${formatNumberList(feedback.foundNumbers)}.`
                  : `Déjà dans la session : ${formatNumberList(feedback.foundNumbers)}.`}
              </p>
            ) : (
              <p className={cx(s.line, s.warn)}>
                <TriangleAlert size={16} strokeWidth={2} className={s.warnIcon} aria-hidden="true" />
                Aucun exercice trouvé en {subjectName} pour cette saisie.
              </p>
            )}

            {feedback.unknown.map((item) => (
              <div key={item.token} className={s.unknown}>
                <p className={cx(s.line, s.warn)}>
                  <TriangleAlert size={16} strokeWidth={2} className={s.warnIcon} aria-hidden="true" />
                  {item.token} n’existe pas en {subjectName}.{item.suggestion ? ` Tu voulais dire ${item.suggestion} ?` : ''}
                </p>
                {item.suggestion ? (
                  <button
                    type="button"
                    className={cx(u.btn, u.secondary, s.correct)}
                    onClick={() => correct(item.suggestion!)}
                  >
                    Corriger en {item.suggestion}
                  </button>
                ) : null}
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

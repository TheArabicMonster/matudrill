import { Info, ListOrdered, RotateCcw } from 'lucide-react';

import { EditableCrop } from '../../components/EditableCrop';
import { Kbd, StatusPill } from '../../components/ui';
import u from '../../components/ui.module.css';
import { cx } from '../../lib/cx';
import { answerSlot, questionSlot, solutionSlot, statementSlot } from '../../lib/slots';
import type { Exercise, Part, ResultValue } from '../../types';
import { EvalButtons } from './EvalButtons';
import { keyOf, type SessionView } from './view';
import s from './SessionPage.module.css';

/** Page d'ouverture d'une réponse : la solution, sinon l'énoncé. */
export function answerPage(exercise: Exercise, part: Part): number {
  return part.answer?.page ?? exercise.solution?.pages[0] ?? exercise.statement[0]?.page ?? exercise.pages[0] ?? 1;
}

export function StepBody({
  view,
  partIndex,
  onSelectPart,
}: {
  view: SessionView;
  partIndex: number;
  onSelectPart: (index: number) => void;
}) {
  const { exercise, subject, parts, results } = view;
  const current = parts.length > 0 ? (parts[partIndex] ?? null) : null;
  const currentKey = keyOf(exercise.id, current);
  const result = results[currentKey] ?? null;
  const revealed = view.revealed[currentKey] === true;
  const editing = view.editing[currentKey] === true;
  const part = current ? exercise.parts.find((item) => item.label === current) : undefined;
  const hasAnswer = Boolean(part?.answer);
  const needsReveal = parts.length === 0 || hasAnswer;
  const evalReady = !needsReveal || revealed;

  const doneParts = parts
    .slice(0, partIndex)
    .map((label, index) => ({
      label,
      index,
      part: exercise.parts.find((item) => item.label === label),
      result: results[keyOf(exercise.id, label)],
    }))
    .filter((entry) => entry.result !== undefined);

  const remaining = parts.length > 0 ? Math.max(parts.length - partIndex - 1, 0) : 0;

  return (
    <>
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
          eager
          className={s.statementImage}
        />
      ))}

      {exercise.solution?.finalOnly ? (
        <p className={s.note}>
          <Info size={18} strokeWidth={2} aria-hidden="true" />
          Le polycopié donne seulement le résultat final.
        </p>
      ) : null}

      <hr className={s.rule} />

      {doneParts.map((entry) => (
        <div key={entry.label} className={s.doneRow}>
          <div className={s.doneQuestion}>
            {entry.part ? (
              <EditableCrop
                exerciseId={exercise.id}
                slot={questionSlot(entry.label)}
                subject={subject}
                crop={entry.part.question}
                alt={`Sous-question ${entry.label})`}
                title={`Sous-question ${entry.label})`}
                page={entry.part.question.page ?? exercise.pages[0] ?? 1}
                scale={0.63}
                imageClassName={s.doneImage}
                variant="inline"
              />
            ) : (
              <span className={s.doneLabel}>{entry.label})</span>
            )}
          </div>
          <StatusPill status={entry.result ?? 'todo'} />
          <button
            type="button"
            className={cx(u.btn, u.ghost, s.revoir)}
            onClick={() => {
              onSelectPart(entry.index);
              view.reveal(entry.label);
            }}
          >
            <RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
            Revoir
          </button>
        </div>
      ))}

      {part ? (
        <div className={s.currentQuestion}>
          <EditableCrop
            exerciseId={exercise.id}
            slot={questionSlot(part.label)}
            subject={subject}
            crop={part.question}
            alt={`Sous-question ${part.label})`}
            title={`Sous-question ${part.label})`}
            page={part.question.page ?? exercise.pages[0] ?? 1}
            eager
          />
        </div>
      ) : null}

      {needsReveal ? (
        <Solution
          view={view}
          exercise={exercise}
          label={current}
          revealed={revealed}
          partAnswer={part?.answer ?? null}
          answerPageValue={part ? answerPage(exercise, part) : null}
        />
      ) : (
        <>
          <p className={s.noAnswer}>Pas de réponse fournie — auto-évalue avec ta démarche.</p>
          {part ? (
            <EditableCrop
              exerciseId={exercise.id}
              slot={answerSlot(part.label)}
              subject={subject}
              crop={null}
              alt={`Réponse ${part.label})`}
              title={`Réponse ${part.label})`}
              page={answerPage(exercise, part)}
            />
          ) : null}
        </>
      )}

      {evalReady ? (
        <div className={cx(s.evalZone, s.evalBar)}>
          {result !== null && !editing ? (
            <div className={s.resultLine}>
              <StatusPill status={result} />
              <span className={s.resultText}>Auto-évaluation enregistrée.</span>
              <button type="button" className={s.change} onClick={() => view.setEditing(current, true)}>
                Changer
              </button>
            </div>
          ) : (
            <>
              <h2 className={s.evalTitle}>Ta réponse était…</h2>
              <EvalButtons
                value={result}
                onPick={(value: ResultValue) => view.evaluate(current, value)}
                label={
                  current ? `Auto-évaluation de la sous-question ${current}` : 'Auto-évaluation de l’exercice'
                }
                disabled={view.saving}
              />
            </>
          )}

          {view.attemptError ? (
            <p className={s.attemptError} role="alert">
              {view.attemptError}
              <button type="button" className={s.change} onClick={view.retry}>
                Réessayer
              </button>
            </p>
          ) : null}
        </div>
      ) : null}

      {parts.length > 0 ? (
        <p className={s.followers}>
          <ListOrdered size={16} strokeWidth={2} aria-hidden="true" />
          {remaining > 0
            ? `${remaining} ${remaining > 1 ? 'sous-questions suivantes' : 'sous-question suivante'}`
            : 'Dernière sous-question'}
        </p>
      ) : null}
    </>
  );
}

function Solution({
  view,
  exercise,
  label,
  revealed,
  partAnswer,
  answerPageValue = null,
}: {
  view: SessionView;
  exercise: Exercise;
  label: string | null;
  revealed: boolean;
  partAnswer: Part['answer'];
  answerPageValue?: number | null;
}) {
  if (!revealed) {
    return (
      <div className={s.revealRow}>
        <button type="button" className={cx(u.btn, u.primary)} onClick={() => view.reveal(label)}>
          Voir la solution
          <Kbd>Espace</Kbd>
        </button>
        <p className={s.hint}>Réponds sur papier, puis révèle la solution.</p>
      </div>
    );
  }

  if (partAnswer && label) {
    return (
      <div className={s.answer}>
        <EditableCrop
          exerciseId={exercise.id}
          slot={answerSlot(label)}
          subject={view.subject}
          crop={partAnswer}
          alt={`Réponse ${label})`}
          title={`Réponse ${label})`}
          page={partAnswer.page ?? answerPageValue ?? exercise.pages[0] ?? 1}
        />
        {answerPageValue !== null ? (
          <p className={s.answerCaption}>
            Solution {exercise.number} · p. {answerPageValue}
          </p>
        ) : null}
      </div>
    );
  }

  if (exercise.solution && exercise.solution.crops.length > 0) {
    return (
      <div className={s.answer}>
        {exercise.solution.crops.map((crop, index) => (
          <EditableCrop
            key={crop.src}
            exerciseId={exercise.id}
            slot={solutionSlot(index)}
            subject={view.subject}
            crop={crop}
            alt={`Solution de l’exercice ${exercise.number}${exercise.solution && exercise.solution.crops.length > 1 ? ` (partie ${index + 1})` : ''}`}
            title={`Solution de l’exercice ${exercise.number}`}
            page={crop.page ?? exercise.solution?.pages[0] ?? 1}
          />
        ))}
        {exercise.solution.pages[0] !== undefined ? (
          <p className={s.answerCaption}>
            Solution {exercise.number} · p. {exercise.solution.pages[0]}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <p className={s.noAnswer}>
      {exercise.solution?.finalOnly
        ? 'Le polycopié donne seulement le résultat final — auto-évalue avec ta démarche.'
        : 'Pas de solution fournie pour cet exercice — auto-évalue avec ta démarche.'}
    </p>
  );
}

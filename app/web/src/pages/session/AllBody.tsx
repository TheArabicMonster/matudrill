import { Eye, Info } from 'lucide-react';

import { EditableCrop } from '../../components/EditableCrop';
import { StatusPill } from '../../components/ui';
import u from '../../components/ui.module.css';
import { cx } from '../../lib/cx';
import { answerSlot, questionSlot, solutionSlot, statementSlot } from '../../lib/slots';
import type { Part, ResultValue } from '../../types';
import { EvalButtons } from './EvalButtons';
import { answerPage } from './StepBody';
import { keyOf, type SessionView } from './view';
import s from './SessionPage.module.css';

export function AllBody({ view }: { view: SessionView }) {
  const { exercise, subject, parts, revealed, editing, saving } = view;
  const revealable = parts.filter((label) => exercise.parts.find((part) => part.label === label)?.answer);
  const allRevealed =
    revealable.length === 0 || revealable.every((label) => revealed[keyOf(exercise.id, label)] === true);

  return (
    <>
      <div className={s.allHead}>
        <h2 className={s.allTitle}>Énoncé</h2>
        <button
          type="button"
          className={cx(u.btn, u.secondary)}
          onClick={view.revealAll}
          disabled={allRevealed}
        >
          <Eye size={16} strokeWidth={2} aria-hidden="true" />
          Tout révéler
        </button>
      </div>

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
            eager
            className={s.statementImage}
          />
        ))}
      </div>

      {exercise.solution?.finalOnly ? (
        <p className={s.note}>
          <Info size={18} strokeWidth={2} aria-hidden="true" />
          Le polycopié donne seulement le résultat final.
        </p>
      ) : null}

      {parts.length === 0 ? (
        <section className={s.partBlock} aria-label="Auto-évaluation de l’exercice">
          <h3 className="visually-hidden">Sous-question unique</h3>
          {exercise.solution && exercise.solution.crops.length > 0 ? (
            <div className={s.solutionRow}>
              <span className={s.solutionLabel}>Solution</span>
              <div className={s.solutionCrops}>
                {exercise.solution.crops.map((crop, index) => (
                  <EditableCrop
                    key={crop.src}
                    exerciseId={exercise.id}
                    slot={solutionSlot(index)}
                    subject={subject}
                    crop={crop}
                    alt={`Solution de l’exercice ${exercise.number}`}
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
            </div>
          ) : (
            <p className={s.partNoAnswer}>
              {exercise.solution?.finalOnly
                ? 'Le polycopié donne seulement le résultat final — auto-évalue avec ta démarche.'
                : 'Pas de solution fournie pour cet exercice — auto-évalue avec ta démarche.'}
            </p>
          )}
          <EvalRow view={view} label={null} />
        </section>
      ) : (
        parts.map((label) => {
          const part: Part | undefined = exercise.parts.find((item) => item.label === label);
          if (!part) return null;
          const key = keyOf(exercise.id, label);
          const isRevealed = revealed[key] === true;
          const hasAnswer = Boolean(part.answer);
          return (
            <section
              key={label}
              className={s.partBlock}
              aria-label={`Sous-question ${label}`}
              onFocus={() => view.setActivePart(label)}
            >
              <h3 className="visually-hidden">Sous-question {label}</h3>
              <EditableCrop
                exerciseId={exercise.id}
                slot={questionSlot(label)}
                subject={subject}
                crop={part.question}
                alt={`Sous-question ${label})`}
                title={`Sous-question ${label})`}
                page={part.question.page ?? exercise.pages[0] ?? 1}
              />

              {hasAnswer ? (
                isRevealed && part.answer ? (
                  <div className={s.solutionRow}>
                    <span className={s.solutionLabel}>Solution</span>
                    <div className={s.solutionCrops}>
                      <EditableCrop
                        exerciseId={exercise.id}
                        slot={answerSlot(label)}
                        subject={subject}
                        crop={part.answer}
                        alt={`Réponse ${label})`}
                        title={`Réponse ${label})`}
                        page={part.answer.page ?? answerPage(exercise, part)}
                      />
                      {part.answer.page !== undefined ? (
                        <p className={s.answerCaption}>p. {part.answer.page}</p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className={s.hiddenSolution}>
                    <span className={s.hiddenText}>Solution masquée</span>
                    <button
                      type="button"
                      className={cx(u.btn, u.secondary)}
                      onClick={() => view.reveal(label)}
                    >
                      <Eye size={16} strokeWidth={2} aria-hidden="true" />
                      Révéler
                    </button>
                  </div>
                )
              ) : (
                <div className={s.solutionRow}>
                  <span className={s.solutionLabel}>Réponse</span>
                  <div className={s.solutionCrops}>
                    <p className={s.partNoAnswer}>Pas de réponse fournie — auto-évalue avec ta démarche.</p>
                    <EditableCrop
                      exerciseId={exercise.id}
                      slot={answerSlot(label)}
                      subject={subject}
                      crop={null}
                      alt={`Réponse ${label})`}
                      title={`Réponse ${label})`}
                      page={answerPage(exercise, part)}
                    />
                  </div>
                </div>
              )}

              {!hasAnswer || isRevealed ? <EvalRow view={view} label={label} /> : null}
            </section>
          );
        })
      )}

      {editing && saving ? <span className="visually-hidden">Enregistrement…</span> : null}
      {view.attemptError ? (
        <p className={s.attemptError} role="alert">
          {view.attemptError}
          <button type="button" className={s.change} onClick={view.retry}>
            Réessayer
          </button>
        </p>
      ) : null}
    </>
  );
}

function EvalRow({ view, label }: { view: SessionView; label: string | null }) {
  const key = keyOf(view.exercise.id, label);
  const result = view.results[key] ?? null;
  const editing = view.editing[key] === true;

  return (
    <div className={s.evalInline} onFocus={() => view.setActivePart(label)}>
      {result !== null && !editing ? (
        <>
          <StatusPill status={result} />
          <span className={s.resultText}>Choisi par toi. Tu peux le changer.</span>
          <button type="button" className={s.change} onClick={() => view.setEditing(label, true)}>
            Changer
          </button>
        </>
      ) : (
        <>
          <span className={s.evalLabel}>Comment as-tu fait ?</span>
          <EvalButtons
            value={result}
            onPick={(value: ResultValue) => view.evaluate(label, value)}
            label={label ? `Auto-évaluation de la sous-question ${label}` : 'Auto-évaluation de l’exercice'}
            disabled={view.saving}
            compact
          />
        </>
      )}
    </div>
  );
}

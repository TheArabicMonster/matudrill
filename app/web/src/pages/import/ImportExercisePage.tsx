import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Frame,
  Layers,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../../api';
import { EditableCrop } from '../../components/EditableCrop';
import { ErrorState, Kbd, Skeleton } from '../../components/ui';
import u from '../../components/ui.module.css';
import { useAsync, useDocumentTitle } from '../../hooks/useAsync';
import { cx } from '../../lib/cx';
import { answerSlot, questionSlot, solutionSlot, statementSlot } from '../../lib/slots';
import { useCrops } from '../../state/crops';
import type { Catalog, Crop, Exercise, Subject } from '../../types';
import { flagIcon } from './flags';
import s from './ImportExercisePage.module.css';

interface Loaded {
  catalog: Catalog;
  exercise: Exercise;
}

export function ImportExercisePage() {
  useDocumentTitle('Vérifier une découpe');
  const { exerciseId } = useParams<{ exerciseId: string }>();
  const navigate = useNavigate();

  const state = useAsync<Loaded>(async () => {
    if (!exerciseId) throw new Error('Exercice inconnu.');
    const [catalog, detail] = await Promise.all([api.catalog(), api.exercise(exerciseId)]);
    return { catalog, exercise: detail.exercise };
  }, [exerciseId]);

  if (state.status === 'loading') {
    return (
      <main id="contenu" className={s.wrap} aria-busy="true">
        <div className={s.skeleton}>
          <Skeleton width="280px" height={30} />
          <div className={s.skeletonGrid}>
            <Skeleton height={320} />
            <Skeleton height={320} />
          </div>
        </div>
        <p className="visually-hidden" role="status">
          Chargement de l’exercice.
        </p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main id="contenu" className={s.wrap}>
        <ErrorState title="Cet exercice n’est pas disponible" message={state.error} onRetry={state.reload} />
        <p className={s.backLink}>
          <button type="button" className={cx(u.btn, u.secondary)} onClick={() => navigate('/import')}>
            Retour à l’import
          </button>
        </p>
      </main>
    );
  }

  return (
    <ExerciseReview
      key={state.data.exercise.id}
      catalog={state.data.catalog}
      exercise={state.data.exercise}
    />
  );
}

function ExerciseReview({ catalog, exercise: loaded }: { catalog: Catalog; exercise: Exercise }) {
  const navigate = useNavigate();
  const { apply, openEditor } = useCrops();
  const exercise = apply(loaded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = catalog.exercises.filter((item) => item.flags.length > 0 && !item.verified);
  const queueIndex = pending.findIndex((item) => item.id === exercise.id);
  const previous = queueIndex > 0 ? pending[queueIndex - 1] : null;
  const next = queueIndex >= 0 && queueIndex + 1 < pending.length ? pending[queueIndex + 1] : null;
  const position = queueIndex >= 0 ? `${queueIndex + 1} sur ${pending.length}` : null;

  const subjectName = catalog.subjects.find((subject) => subject.id === exercise.subject)?.name ?? exercise.subject;
  const subject: Subject = catalog.subjects.find((item) => item.id === exercise.subject) ?? {
    id: exercise.subject,
    name: subjectName,
    pdf: '',
    pages: 0,
  };
  const sectionTitle =
    catalog.sections.find(
      (section) => section.subject === exercise.subject && section.id === exercise.section,
    )?.title ?? '';
  const answerCount = exercise.parts.filter((part) => part.answer !== null).length;
  const pagesLabel =
    exercise.pages.length > 1
      ? `coupé sur ${exercise.pages.length} pages (p. ${exercise.pages.join(' → ')})`
      : `page ${exercise.pages[0] ?? '—'}`;

  const firstSlot = firstCropSlot(exercise);

  const openAdjust = useCallback(() => {
    if (!firstSlot) return;
    openEditor({
      exerciseId: exercise.id,
      slot: firstSlot.slot,
      subject,
      crop: firstSlot.crop,
      title: firstSlot.title,
      page: firstSlot.page,
    });
  }, [exercise.id, firstSlot, openEditor, subject]);

  const validate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.verify(exercise.id, true);
      if (next) navigate(`/import/${next.id}`);
      else navigate('/import');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'La validation n’a pas été enregistrée. Réessaie.');
    } finally {
      setBusy(false);
    }
  }, [busy, exercise.id, navigate, next]);

  const ignore = useCallback(() => {
    if (next) navigate(`/import/${next.id}`);
    else navigate('/import');
  }, [navigate, next]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (target?.closest('[role="dialog"], dialog')) return;
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        navigate('/import');
        return;
      }
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        openAdjust();
        return;
      }
      if (event.key === 'Enter' && !target?.closest('button, a')) {
        event.preventDefault();
        void validate();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, openAdjust, validate]);

  const flagCodes = new Set(exercise.flags.map((flag) => flag.code));
  const checks: { ok: boolean; text: string }[] = [];

  if (exercise.parts.length > 0 && !flagCodes.has('parts_answers_mismatch')) {
    checks.push({
      ok: answerCount === exercise.parts.length,
      text: `${exercise.parts.length} ${exercise.parts.length > 1 ? 'sous-questions' : 'sous-question'} dans l’énoncé, ${answerCount} ${answerCount > 1 ? 'réponses trouvées' : 'réponse trouvée'}`,
    });
  }
  if (!flagCodes.has('split_pages')) {
    checks.push({
      ok: exercise.pages.length <= 1,
      text:
        exercise.pages.length <= 1
          ? `Énoncé entier sur une seule page (p. ${exercise.pages[0] ?? '—'})`
          : `Énoncé coupé sur ${exercise.pages.length} pages (p. ${exercise.pages.join(' → ')})`,
    });
  }
  const hasSolutionBlock = Boolean(exercise.solution && exercise.solution.crops.length > 0);
  if (!flagCodes.has('solution_missing')) {
    checks.push({
      ok: hasSolutionBlock || answerCount > 0,
      text: hasSolutionBlock
        ? `Solution complète (p. ${exercise.solution?.pages[0] ?? '—'})`
        : answerCount > 0
          ? `Réponses finales seulement (p. ${exercise.solution?.pages[0] ?? '—'})`
          : 'Solution introuvable',
    });
  }

  return (
    <main id="contenu" className={s.wrap}>
      <header className={s.head}>
        <div className={s.headTitle}>
          <h1 className={s.title}>Exercice {exercise.number}</h1>
          <p className={s.sub}>
            {subjectName}, {pagesLabel}
          </p>
        </div>
        <div className={s.nav}>
          <button
            type="button"
            className={cx(u.btn, u.secondary)}
            disabled={!previous}
            onClick={() => previous && navigate(`/import/${previous.id}`)}
          >
            <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
            Précédent
          </button>
          {position ? <span className={s.position}>{position}</span> : null}
          <button
            type="button"
            className={cx(u.btn, u.secondary)}
            disabled={!next}
            onClick={() => next && navigate(`/import/${next.id}`)}
          >
            Suivant
            <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={s.grid}>
        <section className={s.panel} aria-labelledby="crops-title">
          <h2 id="crops-title" className={s.panelTitle}>
            Découpes de l’énoncé
          </h2>
          {exercise.statement.length === 0 ? (
            <p className={s.muted}>Aucune découpe d’énoncé pour cet exercice.</p>
          ) : (
            <div className={s.figures}>
              {exercise.statement.map((crop, index) => (
                <figure key={crop.src} className={s.figure}>
                  <figcaption className={s.figureCaption}>
                    {exercise.statement.length > 1 ? `Morceau ${index + 1} · ` : ''}page {crop.page ?? '—'}
                  </figcaption>
                  <div className={s.frame}>
                    <EditableCrop
                      exerciseId={exercise.id}
                      slot={statementSlot(index)}
                      subject={subject}
                      crop={crop}
                      alt={`Découpe ${index + 1} de l’énoncé de l’exercice ${exercise.number}, page ${crop.page ?? '—'}`}
                      title={`Énoncé de l’exercice ${exercise.number}`}
                      page={crop.page ?? exercise.pages[0] ?? 1}
                      scale={0.47}
                    />
                  </div>
                </figure>
              ))}
            </div>
          )}
          <p className={s.muted}>
            {subjectName} · {sectionTitle} · {exercise.pages.length > 1 ? 'assemblage de 2 pages' : '1 page'}
          </p>
        </section>

        <section className={s.panel} aria-labelledby="preview-title">
          <h2 id="preview-title" className={s.panelTitle}>
            Ce que l’app va montrer
          </h2>

          <div className={s.preview}>
            <div className={s.previewImages}>
              {exercise.statement.map((crop, index) => (
                <EditableCrop
                  key={crop.src}
                  exerciseId={exercise.id}
                  slot={statementSlot(index)}
                  subject={subject}
                  crop={crop}
                  alt={`Aperçu de l’énoncé, partie ${index + 1}`}
                  title={`Énoncé de l’exercice ${exercise.number}`}
                  page={crop.page ?? exercise.pages[0] ?? 1}
                  scale={0.3}
                />
              ))}
            </div>

            {hasSolutionBlock && exercise.solution ? (
              <div className={s.solutionBlock}>
                <p className={s.solutionLabel}>
                  Solution {exercise.number} · p. {exercise.solution.pages[0] ?? '—'}
                </p>
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
                    scale={0.3}
                  />
                ))}
              </div>
            ) : exercise.parts.length > 0 ? (
              <div className={s.solutionBlock}>
                <p className={s.solutionLabel}>
                  Réponses du polycopié · p. {exercise.solution?.pages[0] ?? '—'}
                </p>
                <ul className={s.answerList}>
                  {exercise.parts.map((part) => (
                    <li key={part.label} className={s.answerItem}>
                      <span className={s.answerLabel}>{part.label})</span>
                      <EditableCrop
                        exerciseId={exercise.id}
                        slot={answerSlot(part.label)}
                        subject={subject}
                        crop={part.answer}
                        alt={`Réponse ${part.label})`}
                        title={`Réponse ${part.label})`}
                        page={part.answer?.page ?? exercise.solution?.pages[0] ?? exercise.pages[0] ?? 1}
                        scale={0.3}
                        imageClassName={s.answerImage}
                        variant="inline"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {exercise.pages.length > 1 ? (
            <div className={s.proposal}>
              <Layers size={20} strokeWidth={2} aria-hidden="true" />
              <div>
                <h3 className={s.proposalTitle}>Assembler les deux morceaux</h3>
                <p className={s.proposalText}>
                  L’exercice commence p. {exercise.pages[0]} et finit p. {exercise.pages[exercise.pages.length - 1]}.
                  Les découpes sont collées dans cet ordre en un seul exercice.
                </p>
              </div>
            </div>
          ) : null}

          <h2 className={s.sectionTitle}>Contrôles</h2>
          <ul className={s.checks}>
            {checks.map((check) => (
              <li key={check.text} className={s.check}>
                {check.ok ? (
                  <CheckCircle2 size={18} strokeWidth={2} className={s.checkOk} aria-hidden="true" />
                ) : (
                  <TriangleAlert size={18} strokeWidth={2} className={s.checkWarn} aria-hidden="true" />
                )}
                {check.text}
              </li>
            ))}
            {exercise.flags.map((flag) => {
              const Icon = flagIcon(flag.code);
              return (
                <li key={flag.code + flag.message} className={s.check}>
                  <Icon size={18} strokeWidth={2} className={s.checkWarn} aria-hidden="true" />
                  {flag.message}
                </li>
              );
            })}
            {exercise.flags.length === 0 ? (
              <li className={s.check}>
                <CheckCircle2 size={18} strokeWidth={2} className={s.checkOk} aria-hidden="true" />
                Aucun problème signalé par l’extraction.
              </li>
            ) : null}
          </ul>

          <div className={s.actions}>
            <button type="button" className={s.validate} onClick={() => void validate()} disabled={busy}>
              <CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" />
              Valider
              <Kbd>Entrée</Kbd>
            </button>
            <button
              type="button"
              className={cx(u.btn, u.secondary)}
              onClick={openAdjust}
              disabled={!firstSlot}
            >
              <Frame size={18} strokeWidth={2} aria-hidden="true" />
              Ajuster la découpe
              <Kbd>A</Kbd>
            </button>
            <button type="button" className={cx(u.btn, u.ghost)} onClick={ignore}>
              Ignorer
            </button>
          </div>

          {error ? (
            <p className={s.error} role="alert">
              {error}
              <button type="button" className={s.retry} onClick={() => void validate()}>
                Réessayer
              </button>
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}

/** Premier emplacement disponible : l'éditeur s'ouvre là où il y a une image. */
function firstCropSlot(
  exercise: Exercise,
): { slot: string; crop: Crop; title: string; page: number } | null {
  const statement = exercise.statement[0];
  if (statement) {
    return {
      slot: statementSlot(0),
      crop: statement,
      title: `Énoncé de l’exercice ${exercise.number}`,
      page: statement.page ?? exercise.pages[0] ?? 1,
    };
  }
  const solution = exercise.solution?.crops[0];
  if (solution) {
    return {
      slot: solutionSlot(0),
      crop: solution,
      title: `Solution de l’exercice ${exercise.number}`,
      page: solution.page ?? exercise.solution?.pages[0] ?? 1,
    };
  }
  const part = exercise.parts[0];
  if (part) {
    return {
      slot: questionSlot(part.label),
      crop: part.question,
      title: `Sous-question ${part.label})`,
      page: part.question.page ?? exercise.pages[0] ?? 1,
    };
  }
  return null;
}

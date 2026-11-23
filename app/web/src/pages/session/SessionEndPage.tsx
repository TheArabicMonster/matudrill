import { ChevronLeft, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../../api';
import { ErrorState, Skeleton, STATUS_META, SubjectTag } from '../../components/ui';
import u from '../../components/ui.module.css';
import { useAsync, useDocumentTitle } from '../../hooks/useAsync';
import { cx } from '../../lib/cx';
import { formatDuration } from '../../lib/timer';
import { useCart } from '../../state/cart';
import type { Catalog, SessionSummary } from '../../types';
import s from './SessionEndPage.module.css';

interface Loaded {
  catalog: Catalog;
  summary: SessionSummary;
}

export function SessionEndPage() {
  useDocumentTitle('Session terminée');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const cart = useCart();
  const [redo, setRedo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useAsync<Loaded>(async () => {
    if (!id) throw new Error('Session inconnue.');
    const [catalog, summary] = await Promise.all([api.catalog(), api.summary(id)]);
    return { catalog, summary };
  }, [id]);

  if (state.status === 'loading') {
    return (
      <main id="contenu" className={s.wrap} aria-busy="true">
        <div className={s.panel}>
          <Skeleton width="260px" height={30} />
          <div className={s.skeletonBody}>
            <Skeleton height={20} />
            <Skeleton height={40} />
            <Skeleton height={120} />
          </div>
        </div>
        <p className="visually-hidden" role="status">
          Chargement du bilan.
        </p>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main id="contenu" className={s.wrap}>
        <div className={s.panel}>
          <ErrorState title="Ce bilan n’est pas disponible" message={state.error} onRetry={state.reload} />
          <p className={s.back}>
            <Link to="/">
              <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
              Retour à la bibliothèque
            </Link>
          </p>
        </div>
      </main>
    );
  }

  const { catalog, summary } = state.data;
  const exercises = summary.exercises;
  const partCount = exercises.reduce((total, exercise) => total + Math.max(exercise.parts.length, 1), 0);
  const errorCount = summary.errors.length;
  const totalTime = summary.totalElapsedMs > 0 ? formatDuration(summary.totalElapsedMs) : null;
  const ErrorIcon = STATUS_META.ko.Icon;

  const subjectName = (subjectId: string) =>
    catalog.subjects.find((subject) => subject.id === subjectId)?.name ?? subjectId;
  const sectionTitle = (exerciseId: string) => {
    const reference = catalog.exercises.find((exercise) => exercise.id === exerciseId);
    if (!reference) return '';
    const section = catalog.sections.find(
      (item) => item.subject === reference.subject && item.id === reference.section,
    );
    return `${reference.section} ${section?.title ?? ''}`.trim();
  };
  const exerciseNumber = (exerciseId: string) =>
    catalog.exercises.find((exercise) => exercise.id === exerciseId)?.number ?? exerciseId;
  const exerciseSubject = (exerciseId: string) =>
    catalog.exercises.find((exercise) => exercise.id === exerciseId)?.subject ?? '';

  async function redoErrors() {
    if (!id) return;
    const groups = new Map<string, string[]>();
    for (const item of summary.errors) {
      const parts = groups.get(item.exerciseId) ?? [];
      if (item.part) parts.push(item.part);
      groups.set(item.exerciseId, parts);
    }
    const items = [...groups].map(([exerciseId, parts]) => ({ exerciseId, parts }));
    if (items.length === 0) return;

    setRedo(true);
    setError(null);
    try {
      const created = await api.createSession({ items, mode: summary.mode });
      navigate(`/session/${created.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'La nouvelle session n’a pas pu démarrer. Réessaie.');
    } finally {
      setRedo(false);
    }
  }

  return (
    <main id="contenu" className={s.wrap}>
      <div className={s.panel}>
        <h1 className={s.title}>Session terminée</h1>
        <p className={s.lead}>
          {exercises.length} {exercises.length > 1 ? 'exercices' : 'exercice'}, {partCount}{' '}
          {partCount > 1 ? 'sous-questions' : 'sous-question'}
          {totalTime ? `, ${totalTime}` : ''} —{' '}
          {errorCount > 0 ? `${errorCount} à revoir` : 'aucune erreur'}
        </p>

        <div className={s.actions}>
          {errorCount > 0 ? (
            <button
              type="button"
              className={cx(u.btn, u.primary)}
              onClick={() => void redoErrors()}
              disabled={redo}
            >
              <RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
              {redo
                ? 'Ouverture…'
                : `Refaire ${errorCount > 1 ? `les ${errorCount} erreurs` : 'l’erreur'}`}
            </button>
          ) : null}
          <button
            type="button"
            className={cx(u.btn, u.secondary)}
            onClick={() => {
              cart.clear();
              navigate('/');
            }}
          >
            Nouvelle session
          </button>
          <Link to="/" className={s.retour}>
            <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
            Retour à la bibliothèque
          </Link>
        </div>

        {error ? (
          <p className={s.error} role="alert">
            {error}
            <button type="button" className={s.retry} onClick={() => void redoErrors()}>
              Réessayer
            </button>
          </p>
        ) : null}

        <hr className={s.rule} />

        <section aria-labelledby="errors-title">
          <h2 id="errors-title" className={s.sectionTitle}>
            À revoir
          </h2>
          {errorCount === 0 ? (
            <p className={s.empty}>Aucune sous-question à revoir pour cette session.</p>
          ) : (
            <ul className={s.errorList}>
              {summary.errors.map((item, errorIndex) => (
                <li key={`${item.exerciseId}-${item.part ?? 'global'}-${errorIndex}`} className={s.errorRow}>
                  <span className={s.errorIcon} aria-hidden="true">
                    <ErrorIcon size={20} strokeWidth={2} />
                  </span>
                  <span className={s.errorLabel}>
                    Exercice {exerciseNumber(item.exerciseId)}
                    {item.part ? ` · sous-question ${item.part}` : ''}
                  </span>
                  <SubjectTag
                    subjectId={exerciseSubject(item.exerciseId)}
                    name={subjectName(exerciseSubject(item.exerciseId))}
                  />
                  <span className={s.errorSection}>{sectionTitle(item.exerciseId)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="all-title" className={s.allSection}>
          <h2 id="all-title" className={s.sectionTitle}>
            Tous les exercices
          </h2>
          <ul className={s.exerciseList}>
            {exercises.map((exercise) => {
              const reference = catalog.exercises.find((item) => item.id === exercise.exerciseId);
              return (
                <li key={exercise.exerciseId} className={s.exerciseRow}>
                  <div className={s.exerciseIdentity}>
                    <span className={s.exerciseName}>
                      Exercice {reference?.number ?? exercise.exerciseId}
                      {reference?.title ? ` · ${reference.title}` : ''}
                    </span>
                    <div className={s.exerciseMeta}>
                      <SubjectTag
                        subjectId={exerciseSubject(exercise.exerciseId)}
                        name={subjectName(exerciseSubject(exercise.exerciseId))}
                      />
                      <span>{sectionTitle(exercise.exerciseId)}</span>
                    </div>
                  </div>
                  <ul className={s.partPills} aria-label="Résultat par sous-question">
                    {exercise.parts.map((part) => {
                      const meta = STATUS_META[part.result ?? 'todo'];
                      const Icon = meta.Icon;
                      return (
                        <li
                          key={part.label ?? 'global'}
                          className={cx(s.partPill, s[`part_${part.result ?? 'todo'}`])}
                          title={`${part.label ? `Sous-question ${part.label}` : 'Exercice complet'} : ${meta.label}`}
                        >
                          <Icon size={14} strokeWidth={2} aria-hidden="true" />
                          <span>{part.label ?? 'Global'}</span>
                          <span className="visually-hidden">
                            {part.label ? `sous-question ${part.label}` : 'exercice complet'} : {meta.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <span className={cx(s.exerciseTime, exercise.elapsedMs === 0 && s.exerciseTimeEmpty)}>
                    {exercise.elapsedMs > 0 ? `Temps ${formatDuration(exercise.elapsedMs)}` : 'Temps —'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </main>
  );
}

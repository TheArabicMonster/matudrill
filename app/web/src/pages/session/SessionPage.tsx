import { ChevronLeft, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../../api';
import { ThemeToggle } from '../../components/ThemeToggle';
import { ErrorState, Kbd, Segmented, Skeleton, SubjectTag } from '../../components/ui';
import u from '../../components/ui.module.css';
import { useAsync, useDocumentTitle } from '../../hooks/useAsync';
import { useExerciseTimer } from '../../hooks/useExerciseTimer';
import { cx } from '../../lib/cx';
import { useCrops } from '../../state/crops';
import type {
  Catalog,
  Exercise,
  ResultValue,
  SessionDetail,
  SessionMode,
  SessionSummary,
  Subject,
} from '../../types';
import { AllBody } from './AllBody';
import { StepBody } from './StepBody';
import { TimerControl } from './TimerControl';
import { isComplete, keyOf, type Results, type SessionView } from './view';
import s from './SessionPage.module.css';

interface Loaded {
  catalog: Catalog;
  session: SessionDetail;
  summary: SessionSummary;
}

const MODE_OPTIONS: { value: SessionMode; label: string }[] = [
  { value: 'step', label: 'Pas à pas' },
  { value: 'all', label: 'Tout afficher' },
];

const RESULT_LABEL: Record<ResultValue, string> = {
  ok: 'juste',
  mid: 'partiel',
  ko: 'faux',
};

interface RunItem {
  parts: string[];
  exercise: Exercise;
}

function resumePart(items: RunItem[], results: Results): number {
  const first = items[0];
  if (!first || first.parts.length === 0) return 0;
  const index = first.parts.findIndex((label) => results[keyOf(first.exercise.id, label)] === undefined);
  return index === -1 ? 0 : index;
}

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  useDocumentTitle('Session');

  const state = useAsync<Loaded>(async () => {
    if (!id) throw new Error('Session inconnue.');
    const [catalog, session, summary] = await Promise.all([
      api.catalog(),
      api.session(id),
      api.summary(id),
    ]);
    return { catalog, session, summary };
  }, [id]);

  if (state.status === 'loading') {
    return (
      <div className={s.page} aria-busy="true">
        <div className={s.bar}>
          <Skeleton width="120px" height={24} />
          <Skeleton width="200px" height={20} />
          <Skeleton width="220px" height={36} />
        </div>
        <main id="contenu" className={s.main}>
          <div className={s.progress}>
            <Skeleton height={4} />
            <Skeleton width="140px" height={14} />
          </div>
          <div className={cx(s.card, s.cardSkeleton)}>
            <Skeleton width="140px" height={26} />
            <Skeleton height={180} />
            <Skeleton height={80} />
          </div>
        </main>
        <p className="visually-hidden" role="status">
          Chargement de la session.
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={s.page}>
        <main id="contenu" className={s.main}>
          <ErrorState title="Cette session n’est pas disponible" message={state.error} onRetry={state.reload} />
          <p className={s.backLink}>
            <Link to="/">
              <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
              Retour à la bibliothèque
            </Link>
          </p>
        </main>
      </div>
    );
  }

  return <SessionRunner catalog={state.data.catalog} session={state.data.session} summary={state.data.summary} />;
}

function SessionRunner({ catalog, session, summary }: Loaded) {
  const navigate = useNavigate();
  const cardRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const { apply, editorOpen } = useCrops();

  const items = useMemo<RunItem[]>(
    () =>
      session.items.flatMap((item) => {
        const exercise = catalog.exercises.find((candidate) => candidate.id === item.exerciseId);
        return exercise ? [{ parts: item.parts, exercise: apply(exercise) }] : [];
      }),
    [session, catalog, apply],
  );

  const initialResults = useMemo<Results>(() => {
    const map: Results = {};
    for (const exercise of summary.exercises) {
      for (const part of exercise.parts) {
        if (part.result) map[keyOf(exercise.exerciseId, part.label)] = part.result;
      }
    }
    return map;
  }, [summary]);

  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<SessionMode>(session.mode);
  const [results, setResults] = useState<Results>(initialResults);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [partIndex, setPartIndex] = useState(() => resumePart(items, initialResults));
  const [activePart, setActivePart] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ label: string | null; result: ResultValue } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const current = items[index];
  const exercise = current?.exercise;

  // Temps déjà enregistré côté serveur pour l'exercice affiché (rechargement,
  // retour en arrière) : le chronomètre repart de cette valeur.
  const storedElapsedMs = useMemo(
    () => session.items.find((item) => item.exerciseId === exercise?.id)?.elapsedMs ?? 0,
    [session.items, exercise?.id],
  );

  const timer = useExerciseTimer({
    sessionId: session.id,
    exerciseId: exercise?.id ?? null,
    initialElapsedMs: storedElapsedMs,
    editorOpen,
  });

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo(0, 0);
    cardRef.current?.focus({ preventScroll: true });
  }, [index]);

  const reveal = useCallback(
    (label: string | null) => {
      if (!exercise) return;
      setRevealed((previous) => ({ ...previous, [keyOf(exercise.id, label)]: true }));
    },
    [exercise],
  );

  const revealAll = useCallback(() => {
    if (!exercise) return;
    setRevealed((previous) => {
      const next = { ...previous };
      next[keyOf(exercise.id, null)] = true;
      for (const label of current?.parts ?? []) next[keyOf(exercise.id, label)] = true;
      return next;
    });
  }, [exercise, current]);

  const setEditingFor = useCallback(
    (label: string | null, value: boolean) => {
      if (!exercise) return;
      setEditing((previous) => ({ ...previous, [keyOf(exercise.id, label)]: value }));
    },
    [exercise],
  );

  const evaluate = useCallback(
    async (label: string | null, value: ResultValue) => {
      if (!exercise || !current) return;
      const key = keyOf(exercise.id, label);
      const previousResult = results[key];
      setSaving(true);
      setAttemptError(null);
      setResults((previous) => ({ ...previous, [key]: value }));

      try {
        await api.attempt({
          exerciseId: exercise.id,
          part: label,
          result: value,
          sessionId: session.id,
        });
        setEditing((previous) => ({ ...previous, [key]: false }));
        setFailed(null);
        setAnnouncement(
          `Auto-évaluation enregistrée${label ? ` pour la sous-question ${label}` : ''} : ${RESULT_LABEL[value]}.`,
        );

        if (mode === 'step' && current.parts.length > 0) {
          const updated = { ...results, [key]: value };
          const from = label ? current.parts.indexOf(label) : 0;
          let next: number | null = null;
          for (let i = from + 1; i < current.parts.length; i += 1) {
            const candidate = current.parts[i];
            if (candidate && updated[keyOf(exercise.id, candidate)] === undefined) {
              next = i;
              break;
            }
          }
          if (next === null) {
            for (let i = 0; i < current.parts.length; i += 1) {
              const candidate = current.parts[i];
              if (candidate && updated[keyOf(exercise.id, candidate)] === undefined) {
                next = i;
                break;
              }
            }
          }
          if (next !== null) setPartIndex(next);
        }
      } catch (error) {
        setResults((previous) => {
          const next = { ...previous };
          if (previousResult) next[key] = previousResult;
          else delete next[key];
          return next;
        });
        setAttemptError(
          error instanceof Error
            ? error.message
            : 'Ton auto-évaluation n’a pas été enregistrée. Réessaie.',
        );
        setFailed({ label, result: value });
      } finally {
        setSaving(false);
      }
    },
    [current, exercise, mode, results, session.id],
  );

  const retry = useCallback(() => {
    if (!failed) return;
    void evaluate(failed.label, failed.result);
  }, [evaluate, failed]);

  const finish = useCallback(async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      // Le temps du dernier exercice doit être enregistré avant la clôture.
      await timer.flush();
      await api.finish(session.id);
      navigate(`/session/${session.id}/fin`);
    } catch (error) {
      setFinishError(
        error instanceof Error ? error.message : 'La session n’a pas pu être terminée. Réessaie.',
      );
    } finally {
      setFinishing(false);
    }
  }, [navigate, session.id, timer.flush]);

  const goNext = useCallback(async () => {
    if (mode === 'step' && current && !isComplete({ exercise: current.exercise, parts: current.parts, results })) {
      return;
    }
    if (!current) return;
    if (index + 1 < items.length) {
      setIndex(index + 1);
      setPartIndex(0);
      setActivePart(null);
      setFinishError(null);
      const next = items[index + 1];
      if (next) {
        setAnnouncement(`Exercice ${next.exercise.number}, ${index + 2} sur ${items.length}.`);
      }
      return;
    }
    await finish();
  }, [current, finish, index, items, mode, results]);

  const revealShortcut = useCallback(() => {
    if (!exercise || !current) return;
    if (mode === 'step') {
      const label = current.parts.length > 0 ? (current.parts[partIndex] ?? null) : null;
      if (revealed[keyOf(exercise.id, label)]) return;
      if (label !== null && !exercise.parts.find((part) => part.label === label)?.answer) return;
      reveal(label);
      return;
    }
    const candidates = current.parts.filter(
      (label) => exercise.parts.find((part) => part.label === label)?.answer,
    );
    const pending = candidates.filter((label) => !revealed[keyOf(exercise.id, label)]);
    const target = pending.find((label) => label === activePart) ?? pending[0];
    if (target) reveal(target);
  }, [activePart, current, exercise, mode, partIndex, reveal, revealed]);

  const pick = useCallback(
    (value: ResultValue) => {
      if (!exercise || !current) return;
      if (mode === 'step') {
        const label = current.parts.length > 0 ? (current.parts[partIndex] ?? null) : null;
        const part = exercise.parts.find((item) => item.label === label);
        const ready = label === null ? revealed[keyOf(exercise.id, null)] === true : part?.answer ? revealed[keyOf(exercise.id, label)] === true : true;
        if (ready) void evaluate(label, value);
        return;
      }
      const label = activePart ?? current.parts[0] ?? null;
      const part = exercise.parts.find((item) => item.label === label);
      const ready =
        label === null || !part?.answer || revealed[keyOf(exercise.id, label)] === true;
      if (ready) void evaluate(label, value);
    },
    [activePart, current, evaluate, exercise, mode, partIndex, revealed],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('dialog[open]')) return;
      if (event.defaultPrevented) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        navigate('/');
        return;
      }

      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        pick('ok');
        return;
      }
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        pick('mid');
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        pick('ko');
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void goNext();
        return;
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        if (target?.closest('button, a')) return;
        event.preventDefault();
        revealShortcut();
        return;
      }
      if (event.key === 't' || event.key === 'T') {
        event.preventDefault();
        timer.togglePause();
        return;
      }
      if (event.key === 'Enter') {
        if (target?.closest('button, a')) return;
        event.preventDefault();
        void goNext();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, navigate, pick, revealShortcut, timer.togglePause]);

  if (!current || !exercise) {
    return (
      <div className={s.page}>
        <main id="contenu" className={s.main}>
          <div className={s.emptyCard}>
            <h1 className={s.emptyTitle}>Cette session ne contient aucun exercice</h1>
            <p className={s.emptyText}>Reviens à la bibliothèque pour composer une session.</p>
            <Link to="/" className={cx(u.btn, u.primary)}>
              Retour à la bibliothèque
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const labels = current.parts;
  const segments = labels.length > 0 ? labels : [null];
  const currentSegment = labels.length > 0 ? partIndex : 0;
  const complete = isComplete({ exercise, parts: labels, results });
  const isLast = index + 1 === items.length;
  const sectionTitle =
    catalog.sections.find(
      (section) => section.subject === exercise.subject && section.id === exercise.section,
    )?.title ?? '';
  const subjectName = catalog.subjects.find((subject) => subject.id === exercise.subject)?.name ?? '';
  const subject: Subject = catalog.subjects.find((item) => item.id === exercise.subject) ?? {
    id: exercise.subject,
    name: subjectName,
    pdf: '',
    pages: 0,
  };

  const view: SessionView = {
    exercise,
    subject,
    parts: labels,
    results,
    revealed,
    editing,
    saving,
    attemptError,
    activePart,
    setActivePart,
    reveal,
    revealAll,
    evaluate: (label, value) => void evaluate(label, value),
    setEditing: setEditingFor,
    retry,
  };

  return (
    <div className={s.page}>
      <header className={s.bar}>
        <div className={s.barLeft}>
          <button type="button" className={cx(u.btn, u.ghost, s.quit)} onClick={() => navigate('/')}>
            <X size={18} strokeWidth={2.2} aria-hidden="true" />
            Quitter
          </button>
          <Kbd>Échap</Kbd>
        </div>

        <div className={s.barCenter}>
          <h1 className={s.heading}>
            Exercice {exercise.number} · {index + 1} sur {items.length}
          </h1>
          <SubjectTag subjectId={exercise.subject} name={subjectName} />
          <span className={s.sectionTitle}>
            {exercise.section} {sectionTitle}
          </span>
        </div>

        <div className={s.barRight}>
          <TimerControl
            elapsedMs={timer.elapsedMs}
            paused={timer.paused}
            visible={timer.visible}
            onTogglePause={timer.togglePause}
            onToggleVisible={timer.toggleVisible}
          />
          <Segmented
            label="Mode d’affichage"
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
            className={s.modeDesktop}
          />
          <select
            className={cx(u.select, s.modeSelect)}
            aria-label="Mode d’affichage"
            value={mode}
            onChange={(event) => setMode(event.target.value as SessionMode)}
          >
            {MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ThemeToggle />
        </div>
      </header>

      <main id="contenu" className={s.main}>
        {mode === 'step' ? (
          <div className={s.progress}>
            <div className={s.segments} aria-hidden="true">
              {segments.map((label, segmentIndex) => {
                const key = keyOf(exercise.id, label);
                const value = results[key];
                return (
                  <span
                    key={label ?? 'global'}
                    className={cx(
                      s.segment,
                      segmentIndex === currentSegment && s.segmentCurrent,
                      segmentIndex !== currentSegment && value === 'ok' && s.segmentOk,
                      segmentIndex !== currentSegment && value === 'mid' && s.segmentMid,
                      segmentIndex !== currentSegment && value === 'ko' && s.segmentKo,
                    )}
                  />
                );
              })}
            </div>
            <p className={s.progressLabel}>
              {labels.length > 0
                ? `Sous-question ${Math.min(partIndex + 1, labels.length)} sur ${labels.length}`
                : 'Auto-évaluation globale'}
            </p>
          </div>
        ) : null}

        <article className={s.card} ref={cardRef} tabIndex={-1} aria-label={`Exercice ${exercise.number}`}>
          {exercise.title ? (
            <div className={s.cardHead}>
              <h2 className={s.exerciseTitle}>{exercise.title}</h2>
            </div>
          ) : null}

          {mode === 'step' ? (
            <StepBody view={view} partIndex={partIndex} onSelectPart={setPartIndex} />
          ) : (
            <AllBody view={view} />
          )}
        </article>

        {mode === 'all' || complete ? (
          <div className={s.nextRow}>
            <button
              type="button"
              className={cx(u.btn, u.primary, s.nextButton)}
              onClick={() => void goNext()}
              disabled={finishing}
            >
              {isLast ? 'Terminer la session' : 'Exercice suivant'}
              <Kbd>{isLast ? 'Entrée' : '→'}</Kbd>
            </button>
          </div>
        ) : null}

        {finishError ? (
          <p className={s.finishError} role="alert">
            {finishError}
            <button type="button" className={s.changeButton} onClick={() => void finish()}>
              Réessayer
            </button>
          </p>
        ) : null}
      </main>

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

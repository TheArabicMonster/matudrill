import { Eye, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../api';
import { EmptyState, ErrorState, Kbd, Skeleton, SkeletonList, StatusPill, STATUS_META } from '../../components/ui';
import u from '../../components/ui.module.css';
import { useAsync, useDocumentTitle } from '../../hooks/useAsync';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { cx } from '../../lib/cx';
import { formatPages, formatShortDate } from '../../lib/format';
import { formatDuration } from '../../lib/timer';
import { useCart } from '../../state/cart';
import { useCrops } from '../../state/crops';
import type { Catalog, Exercise, Status } from '../../types';
import { AddByNumber } from './AddByNumber';
import { EmptyLibrary } from './EmptyLibrary';
import { PreviewPanel } from './PreviewPanel';
import { SessionCart } from './SessionCart';
import s from './LibraryPage.module.css';

const STATUS_ORDER: Status[] = ['ko', 'mid', 'ok', 'todo'];

const STATUS_ICON_CLASS: Record<Status, string> = {
  ok: s.iconOk,
  mid: s.iconMid,
  ko: s.iconKo,
  todo: s.iconTodo,
};

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

interface Group {
  key: string;
  subjectId: string;
  subjectName: string;
  sectionId: string;
  sectionTitle: string;
  exercises: Exercise[];
}

function buildGroups(catalog: Catalog, exercises: Exercise[]): Group[] {
  const groups = new Map<string, Group>();
  for (const exercise of exercises) {
    const key = `${exercise.subject}::${exercise.section}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        subjectId: exercise.subject,
        subjectName: catalog.subjects.find((subject) => subject.id === exercise.subject)?.name ?? exercise.subject,
        sectionId: exercise.section,
        sectionTitle:
          catalog.sections.find(
            (section) => section.subject === exercise.subject && section.id === exercise.section,
          )?.title ?? '',
        exercises: [],
      };
      groups.set(key, group);
    }
    group.exercises.push(exercise);
  }
  return [...groups.values()];
}

export function LibraryPage() {
  useDocumentTitle('Bibliothèque');
  const catalogState = useAsync<Catalog>(() => api.catalog(), []);
  const cart = useCart();
  const navigate = useNavigate();

  const [subjectFilter, setSubjectFilter] = useState<string | 'all' | null>(null);
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(() => new Set());
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerOpen, drawerRef);

  const { apply } = useCrops();
  const catalog = catalogState.status === 'ready' ? catalogState.data : null;
  const activeSubject: string | 'all' = subjectFilter ?? catalog?.subjects[0]?.id ?? 'all';

  const subjectName = useCallback(
    (id: string) => catalog?.subjects.find((subject) => subject.id === id)?.name ?? id,
    [catalog],
  );

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const needle = normalize(query.trim());
    return catalog.exercises.filter((exercise) => {
      if (activeSubject !== 'all' && exercise.subject !== activeSubject) return false;
      if (statusFilter.size > 0 && !statusFilter.has(exercise.status)) return false;
      if (needle.length === 0) return true;
      const section = catalog.sections.find(
        (item) => item.subject === exercise.subject && item.id === exercise.section,
      );
      const haystack = normalize(
        [exercise.number, exercise.title ?? '', section?.title ?? '', subjectName(exercise.subject)].join(' '),
      );
      return haystack.includes(needle);
    });
  }, [catalog, activeSubject, statusFilter, query, subjectName]);

  const groups = useMemo(() => (catalog ? buildGroups(catalog, filtered) : []), [catalog, filtered]);

  const byId = useMemo(
    () => new Map((catalog?.exercises ?? []).map((exercise) => [exercise.id, exercise])),
    [catalog],
  );

  const preview = previewId ? byId.get(previewId) : undefined;
  const previewExercise = preview && catalog ? apply(preview) : undefined;

  const startSession = useCallback(async () => {
    if (cart.count === 0 || starting) return;
    const items = cart.items
      .map((item) => {
        const exercise = byId.get(item.exerciseId);
        if (!exercise) return null;
        if (exercise.parts.length > 0 && item.parts.length === 0) return null;
        return { exerciseId: item.exerciseId, parts: item.parts };
      })
      .filter((item): item is { exerciseId: string; parts: string[] } => item !== null);

    if (items.length === 0) {
      setStartError('Aucun exercice valide dans la session. Coche au moins une sous-question.');
      return;
    }

    setStarting(true);
    setStartError(null);
    try {
      const session = await api.createSession({ items, mode: cart.mode });
      navigate(`/session/${session.id}`);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'La session n’a pas pu démarrer. Réessaie.');
    } finally {
      setStarting(false);
    }
  }, [byId, cart.count, cart.items, cart.mode, navigate, starting]);

  const startRef = useRef(startSession);
  startRef.current = startSession;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
      const inDialog = target?.closest('[role="dialog"], dialog') || document.querySelector('dialog[open]');

      if (event.key === '/' && !typing && !inDialog) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }

      if (event.key === 'Escape') {
        if (drawerOpen) {
          event.preventDefault();
          setDrawerOpen(false);
        }
        return;
      }

      if (event.key === 'Enter' && !typing && !inDialog && !event.defaultPrevented) {
        if (target?.closest('button, a')) return;
        event.preventDefault();
        void startRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  function toggleStatus(status: Status) {
    setStatusFilter((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function openPreview(exercise: Exercise) {
    setPreviewId(exercise.id);
  }

  function closePreview() {
    const id = preview?.id;
    setPreviewId(null);
    if (!id) return;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-exercise-id="${id}"]`)?.focus();
    });
  }

  if (catalogState.status === 'loading') {
    return (
      <main id="contenu" className={s.page} aria-busy="true">
        <div className={s.side}>
          <Skeleton width="112px" height={22} />
          <div className={u.skeletonStack}>
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        </div>
        <div className={s.main}>
          <div className={s.panel}>
            <div className={s.toolbar}>
              <Skeleton width="340px" height={40} />
              <Skeleton width="240px" height={40} />
            </div>
            <SkeletonList rows={8} />
          </div>
        </div>
        <aside className={s.cartColumn}>
          <div className={s.panel}>
            <SkeletonList rows={4} />
          </div>
        </aside>
        <p className="visually-hidden" role="status">
          Chargement de la bibliothèque.
        </p>
      </main>
    );
  }

  if (catalogState.status === 'error') {
    return (
      <main id="contenu" className={s.pageSingle}>
        <ErrorState message={catalogState.error} onRetry={catalogState.reload} />
      </main>
    );
  }

  if (!catalog || catalog.exercises.length === 0) {
    return (
      <main id="contenu">
        <EmptyLibrary />
      </main>
    );
  }

  const statusSummary =
    statusFilter.size === 0
      ? 'Aucun filtre : tous les exercices sont listés.'
      : `Filtre actif : ${STATUS_ORDER.filter((status) => statusFilter.has(status))
          .map((status) => STATUS_META[status].label)
          .join(', ')}.`;

  const cartPanel = (
    <SessionCart
      catalog={catalog}
      onStart={() => void startSession()}
      starting={starting}
      startError={startError}
    />
  );

  return (
    <main id="contenu" className={s.page}>
      <h1 id="library-title" className="visually-hidden">
        Bibliothèque
      </h1>
      <aside className={s.side} aria-label="Filtres">
        <div className={s.sideBlock}>
          <h2 className={s.sideTitle}>Matières</h2>
          <ul className={s.subjectList}>
            <li>
              <button
                type="button"
                className={s.subjectRow}
                aria-pressed={activeSubject === 'all'}
                onClick={() => setSubjectFilter('all')}
              >
                <span className={s.subjectName}>Toutes les matières</span>
                <span className={s.subjectCount}>{catalog.exercises.length}</span>
              </button>
            </li>
            {catalog.subjects.map((subject) => (
              <li key={subject.id}>
                <button
                  type="button"
                  className={s.subjectRow}
                  aria-pressed={activeSubject === subject.id}
                  onClick={() => setSubjectFilter(subject.id)}
                >
                  <span className={cx(s.subjectDot, s[`dot_${subject.id}`])} aria-hidden="true" />
                  <span className={s.subjectName}>{subject.name}</span>
                  <span className={s.subjectCount}>
                    {catalog.exercises.filter((exercise) => exercise.subject === subject.id).length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className={s.sideBlock}>
          <h2 className={s.sideTitle}>Statut</h2>
          <ul className={s.statusList}>
            {STATUS_ORDER.map((status) => {
              const { label, Icon } = STATUS_META[status];
              return (
                <li key={status}>
                  <label className={s.statusRow}>
                    <input
                      type="checkbox"
                      className={s.check}
                      checked={statusFilter.has(status)}
                      onChange={() => toggleStatus(status)}
                    />
                    <Icon size={16} strokeWidth={2} className={STATUS_ICON_CLASS[status]} aria-hidden="true" />
                    <span className={s.statusLabel}>{label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className={s.sideHelp}>{statusSummary}</p>
        </div>

        <div className={s.shortcuts}>
          <p className={s.shortcut}>
            <Kbd>/</Kbd>
            <span>Rechercher</span>
          </p>
          <p className={s.shortcut}>
            <Kbd>Espace</Kbd>
            <span>Cocher la ligne</span>
          </p>
          <p className={s.shortcut}>
            <Kbd>Entrée</Kbd>
            <span>Ouvrir l’aperçu</span>
          </p>
          <p className={s.shortcut}>
            <Kbd>N</Kbd>
            <span>Mode nuit / jour</span>
          </p>
        </div>
      </aside>

      <section className={s.main} aria-labelledby="library-title">
        <div className={s.panel}>
          <div className={s.toolbar}>
            <div className={cx(u.field, s.search)}>
              <Search size={18} strokeWidth={2} className={u.fieldIcon} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                className={cx(u.input, u.fieldInput)}
                placeholder="Rechercher un numéro ou un titre"
                aria-label="Rechercher un numéro ou un titre"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button type="button" className={cx(u.btn, u.secondary, s.cartToggle)} onClick={() => setDrawerOpen(true)}>
              Session ({cart.count})
            </button>
          </div>

          <AddByNumber
            subjectId={activeSubject === 'all' ? null : activeSubject}
            subjectName={activeSubject === 'all' ? 'cette matière' : subjectName(activeSubject)}
            exercises={catalog.exercises}
            onAdd={(exercises) => {
              const before = new Set(cart.items.map((item) => item.exerciseId));
              const added = exercises.filter((exercise) => !before.has(exercise.id)).length;
              cart.addExercises(exercises);
              return added;
            }}
          />

          <p className="visually-hidden" aria-live="polite">
            {announcement}
          </p>

          {groups.length === 0 ? (
            <div className={s.noResults}>
              <EmptyState
                icon={Search}
                title="Aucun exercice ne correspond"
                action={
                  <button
                    type="button"
                    className={cx(u.btn, u.secondary)}
                    onClick={() => {
                      setQuery('');
                      setStatusFilter(new Set());
                    }}
                  >
                    Effacer la recherche et les filtres
                  </button>
                }
              >
                <p>
                  {query.trim()
                    ? `Aucun exercice ne correspond à « ${query.trim()} » avec ces filtres.`
                    : 'Aucun exercice ne correspond à ces filtres.'}
                </p>
              </EmptyState>
            </div>
          ) : (
            <div className={s.groups}>
              {groups.map((group) => (
                <section key={group.key} className={s.group} aria-labelledby={`${group.key}-title`}>
                  <div className={s.groupHead}>
                    <h2 id={`${group.key}-title`} className={s.groupTitle}>
                      {activeSubject === 'all' ? `${group.subjectName} · ` : ''}
                      {group.sectionId} {group.sectionTitle}
                    </h2>
                    <span className={s.groupCount}>
                      {group.exercises.length} {group.exercises.length > 1 ? 'exercices' : 'exercice'}
                    </span>
                  </div>
                  <ul className={s.rows} role="list">
                    {group.exercises.map((exercise) => (
                      <ExerciseRow
                        key={exercise.id}
                        exercise={exercise}
                        subjectName={group.subjectName}
                        checked={cart.has(exercise.id)}
                        onToggle={() => cart.toggleExercise(exercise)}
                        onPreview={() => openPreview(exercise)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </section>

      <aside className={s.cartColumn} aria-label="Session">
        {cartPanel}
      </aside>


      {drawerOpen ? (
        <div className={s.drawerLayer}>
          <div className={s.drawerScrim} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
          <div
            className={s.drawer}
            role="dialog"
            aria-label="Session"
            aria-modal="true"
            ref={drawerRef}
            tabIndex={-1}
          >
            <SessionCart
              catalog={catalog}
              onStart={() => void startSession()}
              starting={starting}
              startError={startError}
              variant="drawer"
              onClose={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      ) : null}

      {previewExercise ? (
        <PreviewPanel
          exercise={previewExercise}
          subject={
            catalog.subjects.find((item) => item.id === previewExercise.subject) ?? {
              id: previewExercise.subject,
              name: subjectName(previewExercise.subject),
              pdf: '',
              pages: 0,
            }
          }
          subjectName={subjectName(previewExercise.subject)}
          sectionTitle={
            catalog.sections.find(
              (section) => section.subject === previewExercise.subject && section.id === previewExercise.section,
            )?.title ??
            (previewExercise.title ?? '')
          }
          initialParts={cart.partsOf(previewExercise.id)}
          onAdd={(parts) => {
            cart.addExercise(previewExercise, parts);
            closePreview();
            setAnnouncement(
              `Exercice ${previewExercise.number} ajouté à la session${parts.length > 0 ? ` avec ${parts.length} ${parts.length > 1 ? 'sous-questions' : 'sous-question'}` : ''}.`,
            );
          }}
          onClose={closePreview}
        />
      ) : null}
    </main>
  );
}

function ExerciseRow({
  exercise,
  subjectName,
  checked,
  onToggle,
  onPreview,
}: {
  exercise: Exercise;
  subjectName: string;
  checked: boolean;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const lastAttempt = formatShortDate(exercise.lastAttemptAt);
  const lastDuration = exercise.lastElapsedMs && exercise.lastElapsedMs > 0 ? formatDuration(exercise.lastElapsedMs) : null;
  const partsLabel =
    exercise.parts.length === 0
      ? 'Sans sous-question'
      : `${exercise.parts.length} ${exercise.parts.length > 1 ? 'sous-questions' : 'sous-question'}`;

  return (
    <li
      className={s.row}
      tabIndex={0}
      data-exercise-id={exercise.id}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, label')) return;
        onToggle();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          onToggle();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          onPreview();
        }
      }}
    >
      <label className={s.checkWrap}>
        <input
          type="checkbox"
          className={s.check}
          checked={checked}
          onChange={onToggle}
          tabIndex={-1}
          aria-label={`Inclure l’exercice ${exercise.number} (${subjectName}) dans la session`}
        />
      </label>
      <span className={s.number}>{exercise.number}</span>
      <span className={s.partsLabel}>{partsLabel}</span>
      <span className={s.pageCell}>{formatPages(exercise.pages)}</span>
      <span className={s.statusCell}>
        <StatusPill status={exercise.status} />
      </span>
      <span className={cx(s.attempt, !lastAttempt && s.attemptMuted)}>
        <span className={s.attemptLine}>{lastAttempt ? `Tenté le ${lastAttempt}` : 'Pas encore tenté'}</span>
        {lastDuration ? <span className={s.attemptLine}>· {lastDuration}</span> : null}
      </span>
      <button
        type="button"
        className={s.preview}
        onClick={onPreview}
        aria-label={`Aperçu de l’exercice ${exercise.number}`}
      >
        <Eye size={16} strokeWidth={2} aria-hidden="true" />
        <span className={s.previewLabel}>Aperçu</span>
      </button>
    </li>
  );
}

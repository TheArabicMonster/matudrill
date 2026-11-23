import { CheckCircle2, ChevronRight, FileText, TriangleAlert, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../../api';
import { EmptyState, ErrorState, Skeleton, SubjectTag } from '../../components/ui';
import u from '../../components/ui.module.css';
import { useAsync, useDocumentTitle } from '../../hooks/useAsync';
import { cx } from '../../lib/cx';
import type { Catalog, Exercise } from '../../types';
import { flagIcon } from './flags';
import s from './ImportPage.module.css';

function solutionCount(exercises: Exercise[]): number {
  return exercises.filter(
    (exercise) => exercise.solution !== null || exercise.parts.some((part) => part.answer !== null),
  ).length;
}

function pendingOf(exercises: Exercise[]): Exercise[] {
  return exercises.filter((exercise) => exercise.flags.length > 0 && !exercise.verified);
}

export function ImportPage() {
  useDocumentTitle('Import');
  const state = useAsync<Catalog>(() => api.catalog(), []);
  const [noteOpen, setNoteOpen] = useState(false);

  return (
    <main id="contenu" className={s.wrap}>
      <header className={s.head}>
        <h1 className={s.title}>Import</h1>
        <button
          type="button"
          className={cx(u.btn, u.secondary)}
          aria-expanded={noteOpen}
          aria-controls="import-note"
          onClick={() => setNoteOpen((open) => !open)}
        >
          <Upload size={18} strokeWidth={2} aria-hidden="true" />
          Importer un PDF
        </button>
      </header>

      <div aria-live="polite">
        {noteOpen ? (
          <div className={s.notePanel} id="import-note">
            <p>
              Dépose les PDF dans le dossier <code>pdfs/</code> du projet, puis lance l’extraction. Les exercices
              apparaissent ici dès que le catalogue est à jour.
            </p>
          </div>
        ) : null}
      </div>

      {state.status === 'loading' ? (
        <div className={s.panel} aria-busy="true">
          <div className={s.skeleton}>
            <Skeleton height={48} />
            <Skeleton height={48} />
            <Skeleton height={48} />
          </div>
          <p className="visually-hidden" role="status">
            Chargement de l’import.
          </p>
        </div>
      ) : state.status === 'error' ? (
        <ErrorState title="L’import n’a pas pu être chargé" message={state.error} onRetry={state.reload} />
      ) : state.data.subjects.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Aucun polycopié importé"
          action={
            <Link to="/" className={cx(u.btn, u.secondary)}>
              Retour à la bibliothèque
            </Link>
          }
        >
          <p>
            Dépose les PDF dans le dossier <code>pdfs/</code>, puis lance l’extraction : les exercices arriveront ici
            pour vérification.
          </p>
        </EmptyState>
      ) : (
        <CatalogImport catalog={state.data} />
      )}
    </main>
  );
}

function CatalogImport({ catalog }: { catalog: Catalog }) {
  const pending = pendingOf(catalog.exercises);
  const subjects = catalog.subjects.map((subject) => {
    const exercises = catalog.exercises.filter((exercise) => exercise.subject === subject.id);
    const toVerify = pendingOf(exercises);
    return {
      subject,
      detected: exercises.length,
      solutions: solutionCount(exercises),
      toVerify: toVerify.length,
      firstPending: toVerify[0],
      firstExercise: exercises[0],
    };
  });

  return (
    <>
      <div className={s.panel}>
        <table className={s.table}>
          <caption className="visually-hidden">Polycopiés importés</caption>
          <thead>
            <tr>
              <th scope="col">Fichier</th>
              <th scope="col">Matière</th>
              <th scope="col">Exercices détectés</th>
              <th scope="col">Solutions appariées</th>
              <th scope="col">À vérifier</th>
              <th scope="col">
                <span className="visually-hidden">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {subjects.map(({ subject, detected, solutions, toVerify, firstPending, firstExercise }) => (
              <tr key={subject.id}>
                <td>
                  <span className={s.fileCell}>
                    <FileText size={18} strokeWidth={2} aria-hidden="true" />
                    <span>
                      <span className={s.fileName}>{subject.pdf}</span>
                      <span className={s.filePages}>{subject.pages} p.</span>
                    </span>
                  </span>
                </td>
                <td>
                  <SubjectTag subjectId={subject.id} name={subject.name} />
                </td>
                <td className={s.numeric}>{detected}</td>
                <td className={s.numeric}>{solutions}</td>
                <td>
                  {detected === 0 ? null : toVerify > 0 ? (
                    <span className={s.warnPill}>
                      <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
                      {toVerify} à vérifier
                    </span>
                  ) : (
                    <span className={s.okPill}>
                      <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
                      Tout est bon
                    </span>
                  )}
                </td>
                <td className={s.actionCell}>
                  {firstPending ? (
                    <Link
                      to={`/import/${firstPending.id}`}
                      className={cx(u.btn, u.accent, s.tableAction)}
                      aria-label={`Vérifier les exercices de ${subject.name}`}
                    >
                      Vérifier
                      <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
                    </Link>
                  ) : firstExercise ? (
                    <Link
                      to={`/import/${firstExercise.id}`}
                      className={cx(u.btn, u.secondary, s.tableAction)}
                      aria-label={`Revoir les exercices de ${subject.name}`}
                    >
                      Revoir
                    </Link>
                  ) : (
                    <span className={s.noAction}>Aucun exercice</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className={s.queueSection} aria-labelledby="queue-title">
        <div className={s.queueHead}>
          <h2 id="queue-title" className={s.queueTitle}>
            À vérifier
          </h2>
          <p className={s.queueCount}>
            {pending.length === 0
              ? 'Toutes les découpes sont validées.'
              : `${pending.length} ${pending.length > 1 ? 'exercices attendent' : 'exercice attend'} un coup d’œil avant d’entrer dans la bibliothèque.`}
          </p>
        </div>

        {pending.length === 0 ? (
          <div className={s.panel}>
            <p className={s.emptyQueue}>
              Rien à vérifier. Ouvre un exercice depuis la bibliothèque pour le relire.
            </p>
          </div>
        ) : (
          <ul className={s.queueList}>
            {pending.map((exercise) => {
              const Icon = flagIcon(exercise.flags[0]?.code ?? '');
              return (
                <li key={exercise.id}>
                  <Link to={`/import/${exercise.id}`} className={s.queueRow}>
                    <span className={s.queueIcon} aria-hidden="true">
                      <Icon size={18} strokeWidth={2} />
                    </span>
                    <span className={s.queueName}>
                      Exercice {exercise.number}
                      {exercise.title ? ` — ${exercise.title}` : ''}
                    </span>
                    <SubjectTag
                      subjectId={exercise.subject}
                      name={
                        catalog.subjects.find((subject) => subject.id === exercise.subject)?.name ??
                        exercise.subject
                      }
                    />
                    <span className={s.queueMessage}>
                      {exercise.flags.map((flag) => flag.message).join(' · ')}
                    </span>
                    <ChevronRight size={18} strokeWidth={2} className={s.chevron} aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

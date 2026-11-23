import type { Exercise, ResultValue, Subject } from '../../types';

export type Results = Record<string, ResultValue>;

export function keyOf(exerciseId: string, label: string | null): string {
  return `${exerciseId}::${label ?? ''}`;
}

export interface SessionView {
  exercise: Exercise;
  /** Matière de l'exercice : le PDF à ouvrir dans l'éditeur de recadrage. */
  subject: Subject;
  parts: string[];
  results: Results;
  revealed: Record<string, boolean>;
  editing: Record<string, boolean>;
  saving: boolean;
  attemptError: string | null;
  activePart: string | null;
  setActivePart: (label: string | null) => void;
  reveal: (label: string | null) => void;
  revealAll: () => void;
  evaluate: (label: string | null, result: ResultValue) => void;
  setEditing: (label: string | null, editing: boolean) => void;
  retry: () => void;
}

export function isComplete(view: Pick<SessionView, 'exercise' | 'parts' | 'results'>): boolean {
  if (view.parts.length === 0) {
    return view.results[keyOf(view.exercise.id, null)] !== undefined;
  }
  return view.parts.every((label) => view.results[keyOf(view.exercise.id, label)] !== undefined);
}

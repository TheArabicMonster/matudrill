import type { ResultValue, Status } from './types.js';

/**
 * Statut d'un exercice, dérivé des dernières auto-évaluations de ses
 * sous-questions : tout juste → « réussi », au moins un faux → « à revoir »,
 * sinon « partiel ». Aucune évaluation → « jamais fait ».
 */
export function deriveStatus(results: ResultValue[]): Status {
  if (results.length === 0) return 'todo';
  if (results.some((result) => result === 'ko')) return 'ko';
  if (results.every((result) => result === 'ok')) return 'ok';
  return 'mid';
}

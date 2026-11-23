import type { Catalog, ResolveNumbersResult, UnknownNumber } from './types.js';

/**
 * Analyse une saisie du type « 1.3–1.8, 2.4, 1.93 » et renvoie les exercices
 * existants de la matière, plus les numéros inconnus avec une suggestion.
 *
 * Séparateurs acceptés : virgule, point-virgule, espace, retour à la ligne.
 * Plages acceptées : `1.3-1.8`, `1.3–1.8`, `1.3 — 1.8`, `1.3 à 1.8`.
 */

interface NumberRef {
  chapter: number;
  index: number;
}

const TOKEN_RE = /(\d+)\s*\.\s*(\d+)(?:\s*(?:[-–—]|à|a)\s*(\d+)\s*\.\s*(\d+))?/gi;

const MAX_RANGE = 400;

function refToString(ref: NumberRef): string {
  return `${ref.chapter}.${ref.index}`;
}

function expandRange(start: NumberRef, end: NumberRef): NumberRef[] {
  const from = start.chapter * 100 + start.index;
  const to = end.chapter * 100 + end.index;
  const [low, high] = from <= to ? [start, end] : [end, start];

  const out: NumberRef[] = [];
  if (low.chapter === high.chapter) {
    for (let index = low.index; index <= high.index && out.length < MAX_RANGE; index += 1) {
      out.push({ chapter: low.chapter, index });
    }
    return out;
  }

  for (let chapter = low.chapter; chapter <= high.chapter && out.length < MAX_RANGE; chapter += 1) {
    const first = chapter === low.chapter ? low.index : 1;
    const last = chapter === high.chapter ? high.index : 99;
    for (let index = first; index <= last && out.length < MAX_RANGE; index += 1) {
      out.push({ chapter, index });
    }
  }
  return out;
}

interface ScannedToken {
  text: string;
  isRange: boolean;
  refs: NumberRef[];
}

export function scanNumbers(input: string): ScannedToken[] {
  const tokens: ScannedToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(input)) !== null) {
    const start: NumberRef = { chapter: Number(match[1]), index: Number(match[2]) };
    if (match[3] !== undefined && match[4] !== undefined) {
      const end: NumberRef = { chapter: Number(match[3]), index: Number(match[4]) };
      tokens.push({
        text: `${refToString(start)}–${refToString(end)}`,
        isRange: true,
        refs: expandRange(start, end),
      });
    } else {
      tokens.push({ text: refToString(start), isRange: false, refs: [start] });
    }
  }
  return tokens;
}

function decimalValue(ref: NumberRef): number {
  // « 1.9 » vaut 1,9 et « 1.12 » vaut 1,12 : c'est ainsi qu'un numéro se lit.
  const digits = String(ref.index).length;
  return ref.chapter + ref.index / 10 ** digits;
}

function suggest(ref: NumberRef, numbers: NumberRef[]): string | null {
  // On ne propose qu'un numéro du même chapitre : ailleurs, la suggestion serait fausse.
  const candidates = numbers.filter((candidate) => candidate.chapter === ref.chapter);
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestDistance = Math.abs(decimalValue(best) - decimalValue(ref));
  for (const candidate of candidates) {
    const distance = Math.abs(decimalValue(candidate) - decimalValue(ref));
    if (distance < bestDistance - 1e-9) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return refToString(best);
}

export function resolveNumbers(catalog: Catalog, subject: string, input: string): ResolveNumbersResult {
  const exercises = catalog.exercises.filter((exercise) => exercise.subject === subject);

  const byNumber = new Map<string, string>();
  const refs: NumberRef[] = [];
  for (const exercise of exercises) {
    byNumber.set(exercise.number, exercise.id);
    const [chapter, index] = exercise.number.split('.');
    if (chapter !== undefined && index !== undefined) {
      refs.push({ chapter: Number(chapter), index: Number(index) });
    }
  }
  refs.sort((a, b) => a.chapter * 100 + a.index - (b.chapter * 100 + b.index));

  const found: string[] = [];
  const unknown: UnknownNumber[] = [];
  const seenFound = new Set<string>();
  const seenUnknown = new Set<string>();

  for (const token of scanNumbers(input)) {
    for (const ref of token.refs) {
      const number = refToString(ref);
      const id = byNumber.get(number);
      if (id && !seenFound.has(id)) {
        seenFound.add(id);
        found.push(id);
      }
    }

    if (!token.isRange) {
      const number = token.text;
      if (!byNumber.has(number) && !seenUnknown.has(number)) {
        seenUnknown.add(number);
        const [chapter, index] = number.split('.');
        unknown.push({
          token: number,
          suggestion:
            chapter !== undefined && index !== undefined
              ? suggest({ chapter: Number(chapter), index: Number(index) }, refs)
              : null,
        });
      }
    }
  }

  return { subject, input, found, unknown };
}

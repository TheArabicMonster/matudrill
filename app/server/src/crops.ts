import type { Crop, CropOverride, Exercise } from './types.js';

/**
 * Emplacement d'image dans un exercice :
 * `statement:<i>` · `question:<label>` · `answer:<label>` · `solution:<i>`.
 */
export type SlotKind = 'statement' | 'question' | 'answer' | 'solution';

export interface SlotRef {
  kind: SlotKind;
  /** Index du morceau pour `statement` et `solution`. */
  index: number | null;
  /** Lettre de sous-question pour `question` et `answer`. */
  label: string | null;
}

const INDEX_SLOT_RE = /^(statement|solution):(\d{1,3})$/;
const LABEL_SLOT_RE = /^(question|answer):([A-Za-z0-9]{1,4})$/;

export function parseSlot(raw: string): SlotRef | null {
  const indexed = INDEX_SLOT_RE.exec(raw);
  if (indexed && (indexed[1] === 'statement' || indexed[1] === 'solution')) {
    return { kind: indexed[1], index: Number(indexed[2]), label: null };
  }
  const labelled = LABEL_SLOT_RE.exec(raw);
  if (labelled && (labelled[1] === 'question' || labelled[1] === 'answer')) {
    return { kind: labelled[1], index: null, label: labelled[2]! };
  }
  return null;
}

export type SlotLookup = { ok: true; crop: Crop | null } | { ok: false; message: string };

/** Vérifie que l'emplacement existe dans cet exercice (une réponse peut manquer). */
export function lookupSlot(exercise: Exercise, slot: SlotRef): SlotLookup {
  if (slot.kind === 'statement') {
    const crop = slot.index === null ? undefined : exercise.statement[slot.index];
    return crop
      ? { ok: true, crop }
      : { ok: false, message: `L’exercice ${exercise.number} n’a pas de morceau d’énoncé ${slot.index ?? '?'}.` };
  }

  if (slot.kind === 'solution') {
    const crop = slot.index === null ? undefined : exercise.solution?.crops[slot.index];
    return crop
      ? { ok: true, crop }
      : { ok: false, message: `L’exercice ${exercise.number} n’a pas de morceau de solution ${slot.index ?? '?'}.` };
  }

  const part = exercise.parts.find((item) => item.label === slot.label);
  if (!part) {
    return { ok: false, message: `L’exercice ${exercise.number} n’a pas de sous-question « ${slot.label ?? '?'} ».` };
  }
  return { ok: true, crop: slot.kind === 'answer' ? part.answer : part.question };
}

/** Découpe par défaut : largeur du corps de page, 120 pt de haut au milieu. */
export const DEFAULT_MARGIN_PT = 56;
export const DEFAULT_HEIGHT_PT = 120;

export function defaultRect(widthPt: number, heightPt: number): [number, number, number, number] {
  const top = Math.round((heightPt - DEFAULT_HEIGHT_PT) / 2);
  return [DEFAULT_MARGIN_PT, top, Math.round(widthPt - DEFAULT_MARGIN_PT), top + DEFAULT_HEIGHT_PT];
}

function cloneExercise(exercise: Exercise): Exercise {
  return {
    ...exercise,
    pages: [...exercise.pages],
    statement: exercise.statement.map((crop) => ({ ...crop })),
    parts: exercise.parts.map((part) => ({
      ...part,
      question: { ...part.question },
      answer: part.answer ? { ...part.answer } : null,
    })),
    solution: exercise.solution
      ? { ...exercise.solution, pages: [...exercise.solution.pages], crops: exercise.solution.crops.map((crop) => ({ ...crop })) }
      : null,
    flags: exercise.flags.map((flag) => ({ ...flag })),
  };
}

function overrideCrop(row: CropOverride): Crop {
  return {
    src: row.src,
    w: row.w,
    h: row.h,
    page: row.page,
    rect: [row.x0, row.y0, row.x1, row.y1],
    manual: true,
  };
}

function setSlot(exercise: Exercise, slot: SlotRef, crop: Crop): void {
  if (slot.kind === 'statement') {
    if (slot.index !== null) exercise.statement[slot.index] = crop;
    return;
  }
  if (slot.kind === 'solution') {
    if (exercise.solution && slot.index !== null) exercise.solution.crops[slot.index] = crop;
    return;
  }
  const part = exercise.parts.find((item) => item.label === slot.label);
  if (!part) return;
  if (slot.kind === 'answer') part.answer = crop;
  else part.question = crop;
}

/**
 * Applique les découpes manuelles d'un exercice : `src/w/h/page/rect`
 * remplacés, `manual: true`, et une réponse absente devient une image.
 */
export function applyCropOverrides(exercise: Exercise, overrides: CropOverride[]): Exercise {
  if (overrides.length === 0) return exercise;
  const next = cloneExercise(exercise);
  const applied: string[] = [];
  for (const override of overrides) {
    const slot = parseSlot(override.slot);
    if (!slot) continue;
    const lookup = lookupSlot(next, slot);
    if (!lookup.ok) continue;
    setSlot(next, slot, overrideCrop(override));
    applied.push(override.slot);
  }
  next.manualSlots = applied.sort();
  return next;
}

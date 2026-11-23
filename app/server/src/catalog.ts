import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Catalog, Crop, Exercise, Flag, Part, Section, Solution, Subject } from './types.js';

export const EMPTY_CATALOG: Catalog = {
  version: 1,
  generatedAt: undefined,
  subjects: [],
  sections: [],
  exercises: [],
};

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRect(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
  const [x0, y0, x1, y1] = value as [number, number, number, number];
  if (x1 <= x0 || y1 <= y0) return undefined;
  return [x0, y0, x1, y1];
}

function asCrop(value: unknown): Crop | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const src = asString(raw.src);
  if (!src) return null;
  const crop: Crop = { src, w: asNumber(raw.w), h: asNumber(raw.h) };
  if (typeof raw.page === 'number') crop.page = raw.page;
  const rect = asRect(raw.rect);
  if (rect) crop.rect = rect;
  if (raw.manual === true) crop.manual = true;
  return crop;
}

function asCrops(value: unknown): Crop[] {
  if (!Array.isArray(value)) return [];
  return value.map(asCrop).filter((crop): crop is Crop => crop !== null);
}

function asParts(value: unknown): Part[] {
  if (!Array.isArray(value)) return [];
  const parts: Part[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const question = asCrop(raw.question);
    if (!question) continue;
    parts.push({
      label: asString(raw.label),
      question,
      answer: asCrop(raw.answer),
    });
  }
  return parts;
}

function asSolution(value: unknown): Solution | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return {
    pages: Array.isArray(raw.pages) ? raw.pages.filter((page): page is number => typeof page === 'number') : [],
    crops: asCrops(raw.crops),
    finalOnly: raw.finalOnly === true,
  };
}

function asFlags(value: unknown): Flag[] {
  if (!Array.isArray(value)) return [];
  const flags: Flag[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const code = asString(raw.code);
    if (!code) continue;
    flags.push({ code, message: asString(raw.message) });
  }
  return flags;
}

function asSubjects(value: unknown): Subject[] {
  if (!Array.isArray(value)) return [];
  const subjects: Subject[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = asString(raw.id);
    if (!id) continue;
    subjects.push({
      id,
      name: asString(raw.name, id),
      pdf: asString(raw.pdf),
      pages: asNumber(raw.pages),
    });
  }
  return subjects;
}

function asSections(value: unknown): Section[] {
  if (!Array.isArray(value)) return [];
  const sections: Section[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = asString(raw.id);
    const subject = asString(raw.subject);
    if (!id || !subject) continue;
    sections.push({ subject, id, title: asString(raw.title) });
  }
  return sections;
}

function asExercises(value: unknown): Exercise[] {
  if (!Array.isArray(value)) return [];
  const exercises: Exercise[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = asString(raw.id);
    const subject = asString(raw.subject);
    const number = asString(raw.number);
    if (!id || !subject || !number) continue;
    exercises.push({
      id,
      subject,
      number,
      title: asStringOrNull(raw.title),
      section: asString(raw.section),
      pages: Array.isArray(raw.pages) ? raw.pages.filter((page): page is number => typeof page === 'number') : [],
      statement: asCrops(raw.statement),
      parts: asParts(raw.parts),
      solution: asSolution(raw.solution),
      flags: asFlags(raw.flags),
      verified: raw.verified === true,
    });
  }
  return exercises;
}

/** Lit un catalog.json et tolère les champs manquants, sans jamais planter. */
export function parseCatalog(json: unknown): Catalog {
  if (!json || typeof json !== 'object') return { ...EMPTY_CATALOG };
  const raw = json as Record<string, unknown>;
  return {
    version: asNumber(raw.version, 1),
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : undefined,
    subjects: asSubjects(raw.subjects),
    sections: asSections(raw.sections),
    exercises: asExercises(raw.exercises),
  };
}

export interface CatalogProvider {
  get(): Catalog;
  path: string;
}

/**
 * Catalogue relu depuis le disque quand le fichier change (le pipeline peut
 * tourner pendant que le site est ouvert).
 */
export function createCatalogProvider(dataDir: string): CatalogProvider {
  const path = join(dataDir, 'catalog.json');
  let cached: Catalog = { ...EMPTY_CATALOG };
  let cachedMtime = -1;

  return {
    path,
    get() {
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        cached = { ...EMPTY_CATALOG };
        cachedMtime = -1;
        return cached;
      }
      if (mtime === cachedMtime) return cached;
      try {
        const json = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        cached = parseCatalog(json);
        cachedMtime = mtime;
        return cached;
      } catch (error) {
        console.error(`[matudrill] catalog.json illisible (${path})`, error);
        return cached;
      }
    },
  };
}

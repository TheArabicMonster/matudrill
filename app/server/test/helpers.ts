import type { Catalog, Crop, Exercise, Part } from '../src/types.js';

export function crop(name: string, w = 1000, h = 200, page?: number): Crop {
  const value: Crop = { src: `crops/${name}.png`, w, h };
  if (page !== undefined) value.page = page;
  return value;
}

export function part(label: string, withAnswer = true): Part {
  return {
    label,
    question: crop(`q-${label}`, 500, 45, 13),
    answer: withAnswer ? crop(`s-${label}`, 480, 40, 183) : null,
  };
}

export function exercise(number: string, options: { subject?: string; parts?: Part[] } = {}): Exercise {
  const subject = options.subject ?? 'algebre';
  return {
    id: `${subject}-${number}`,
    subject,
    number,
    title: null,
    section: number.split('.')[0] === '2' ? '2.1' : '1.1',
    pages: [13],
    statement: [crop(`${subject}-${number}-statement-0`, 1072, 583, 13)],
    parts: options.parts ?? [part('a'), part('b')],
    solution: { pages: [183], crops: [crop(`${subject}-${number}-solution-0`, 1072, 239, 183)], finalOnly: false },
    flags: [],
    verified: false,
  };
}

/** Catalogue en mémoire pour les tests : les numéros existent, 1.93 n'existe pas. */
export function makeCatalog(exercises: Exercise[]): Catalog {
  const subjects = [
    { id: 'algebre', name: 'Algèbre', pdf: 'algebre.pdf', pages: 295 },
    { id: 'physique', name: 'Physique I', pdf: 'physique.pdf', pages: 123 },
  ];
  const sections = [
    { subject: 'algebre', id: '1.1', title: 'Introduction aux ensembles' },
    { subject: 'algebre', id: '2.1', title: 'Équations linéaires' },
  ];
  return { version: 1, generatedAt: '2026-11-21T12:00:00Z', subjects, sections, exercises };
}

export const numbers = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10', '1.11', '1.12', '2.1', '2.4'];

export const testCatalog: Catalog = makeCatalog(numbers.map((number) => exercise(number)));

import { describe, expect, it } from 'vitest';

import { resolveNumbers, scanNumbers } from '../src/resolve-numbers.js';
import { makeCatalog, numbers, testCatalog, exercise } from './helpers.js';

describe('scanNumbers', () => {
  it('reconnaît les numéros simples et les plages', () => {
    const tokens = scanNumbers('1.3–1.8, 2.4, 1.93');
    expect(tokens.map((token) => token.text)).toEqual(['1.3–1.8', '2.4', '1.93']);
    expect(tokens[0]?.refs.map((ref) => `${ref.chapter}.${ref.index}`)).toEqual([
      '1.3',
      '1.4',
      '1.5',
      '1.6',
      '1.7',
      '1.8',
    ]);
  });

  it('accepte le tiret, le tiret cadratin, « à » et les espaces', () => {
    for (const input of ['1.3-1.8', '1.3 – 1.8', '1.3 — 1.8', '1.3 à 1.8', 'de 1.3 à 1.8']) {
      expect(scanNumbers(input)[0]?.refs.length, input).toBe(6);
    }
  });

  it('ignore le texte autour des numéros', () => {
    const tokens = scanNumbers('exercices 2.4 et 2.5');
    expect(tokens.map((token) => token.text)).toEqual(['2.4', '2.5']);
  });
});

describe('resolveNumbers', () => {
  it('trouve les 7 exercices de « 1.3–1.8, 2.4, 1.93 » et suggère 1.9', () => {
    const result = resolveNumbers(testCatalog, 'algebre', '1.3–1.8, 2.4, 1.93');
    expect(result.found).toEqual([
      'algebre-1.3',
      'algebre-1.4',
      'algebre-1.5',
      'algebre-1.6',
      'algebre-1.7',
      'algebre-1.8',
      'algebre-2.4',
    ]);
    expect(result.found).toHaveLength(7);
    expect(result.unknown).toEqual([{ token: '1.93', suggestion: '1.9' }]);
  });

  it("ne renvoie que les numéros présents dans le catalogue", () => {
    const catalog = makeCatalog(
      ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.8', '2.4'].map((number) => exercise(number)),
    );
    const result = resolveNumbers(catalog, 'algebre', '1.3–1.8, 2.4');
    expect(result.found).toEqual([
      'algebre-1.3',
      'algebre-1.4',
      'algebre-1.5',
      'algebre-1.6',
      'algebre-1.8',
      'algebre-2.4',
    ]);
    expect(result.found).not.toContain('algebre-1.7');
    expect(result.unknown).toEqual([]);
  });

  it('dédoublonne les numéros saisis deux fois', () => {
    const result = resolveNumbers(testCatalog, 'algebre', '1.1, 1.1, 1.1-1.3');
    expect(result.found).toEqual(['algebre-1.1', 'algebre-1.2', 'algebre-1.3']);
  });

  it('ne mélange pas les matières', () => {
    const catalog = makeCatalog([
      ...numbers.map((number) => exercise(number)),
      exercise('1.3', { subject: 'physique' }),
    ]);
    expect(resolveNumbers(catalog, 'physique', '1.3').found).toEqual(['physique-1.3']);
    expect(resolveNumbers(catalog, 'algebre', '1.3').found).toEqual(['algebre-1.3']);
  });

  it('suggère le numéro le plus proche du même chapitre', () => {
    const catalog = makeCatalog(numbers.map((number) => exercise(number)));
    const result = resolveNumbers(catalog, 'algebre', '1.5, 1.99, 3.1');
    expect(result.unknown).toEqual([
      { token: '1.99', suggestion: '1.9' },
      // Aucun exercice au chapitre 3 : pas de suggestion plutôt qu'un numéro d'un autre chapitre.
      { token: '3.1', suggestion: null },
    ]);
  });

  it('accepte une saisie vide sans inventer de numéro', () => {
    const result = resolveNumbers(testCatalog, 'algebre', '   ');
    expect(result.found).toEqual([]);
    expect(result.unknown).toEqual([]);
  });
});

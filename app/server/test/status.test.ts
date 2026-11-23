import { describe, expect, it } from 'vitest';

import { deriveStatus } from '../src/status.js';

describe('deriveStatus', () => {
  it('renvoie « jamais fait » sans auto-évaluation', () => {
    expect(deriveStatus([])).toBe('todo');
  });

  it('renvoie « réussi » quand toutes les sous-questions sont justes', () => {
    expect(deriveStatus(['ok'])).toBe('ok');
    expect(deriveStatus(['ok', 'ok', 'ok'])).toBe('ok');
  });

  it('renvoie « à revoir » dès qu’une sous-question est fausse', () => {
    expect(deriveStatus(['ko'])).toBe('ko');
    expect(deriveStatus(['ok', 'ko', 'ok'])).toBe('ko');
    expect(deriveStatus(['mid', 'ko'])).toBe('ko');
  });

  it('renvoie « partiel » pour un mélange de justes et de partiels', () => {
    expect(deriveStatus(['mid'])).toBe('mid');
    expect(deriveStatus(['ok', 'mid'])).toBe('mid');
    expect(deriveStatus(['mid', 'mid', 'ok'])).toBe('mid');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { Store } from '../src/db.js';
import type { Catalog } from '../src/types.js';
import { crop, exercise, makeCatalog, numbers, part } from './helpers.js';

let store: Store;
let catalog: Catalog;
let app: ReturnType<typeof createApp>;

function json(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  catalog = makeCatalog([
    exercise('1.1', { parts: [part('a'), part('b'), part('c', false)] }),
    exercise('1.2', { parts: [part('a'), part('b')] }),
    exercise('1.3', { parts: [part('a')] }),
    exercise('2.4', { parts: [] }),
    ...numbers.filter((number) => !['1.1', '1.2', '1.3', '2.4'].includes(number)).map((number) => exercise(number)),
  ]);
  store = new Store(':memory:');
  app = createApp({
    getCatalog: () => catalog,
    store,
    dataDir: '/tmp/matudrill-test',
    appDataDir: '/tmp/matudrill-test/app-data',
  });
});

describe('sessions', () => {
  it('crée une session avec ses exercices et sous-questions', async () => {
    const response = await app.request(
      '/api/sessions',
      json({
        mode: 'step',
        items: [
          { exerciseId: 'algebre-1.1', parts: ['a', 'c'] },
          { exerciseId: 'algebre-2.4', parts: [] },
        ],
      }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    expect(created.id).toMatch(/^ses_/);

    const read = await app.request(`/api/sessions/${created.id}`);
    expect(read.status).toBe(200);
    const session = (await read.json()) as {
      mode: string;
      items: { exerciseId: string; parts: string[]; position: number; elapsedMs: number }[];
      finishedAt: string | null;
      totalElapsedMs: number;
    };
    expect(session.mode).toBe('step');
    expect(session.finishedAt).toBeNull();
    expect(session.items).toEqual([
      { exerciseId: 'algebre-1.1', parts: ['a', 'c'], position: 0, elapsedMs: 0 },
      { exerciseId: 'algebre-2.4', parts: [], position: 1, elapsedMs: 0 },
    ]);
    expect(session.totalElapsedMs).toBe(0);
  });

  it('refuse une session vide ou une sous-question inconnue', async () => {
    expect((await app.request('/api/sessions', json({ mode: 'step', items: [] }))).status).toBe(400);
    const unknownPart = await app.request(
      '/api/sessions',
      json({ mode: 'step', items: [{ exerciseId: 'algebre-1.1', parts: ['z'] }] }),
    );
    expect(unknownPart.status).toBe(400);
    const unknownExercise = await app.request(
      '/api/sessions',
      json({ mode: 'all', items: [{ exerciseId: 'algebre-9.9', parts: ['a'] }] }),
    );
    expect(unknownExercise.status).toBe(404);
  });

  it('renvoie 404 pour une session inconnue', async () => {
    expect((await app.request('/api/sessions/ses_inconnue')).status).toBe(404);
    expect((await app.request('/api/sessions/ses_inconnue/summary')).status).toBe(404);
    expect((await app.request('/api/sessions/ses_inconnue/finish', json({}))).status).toBe(404);
  });

  it('enregistre les auto-évaluations et calcule le résumé puis la fin de session', async () => {
    const created = (await (
      await app.request(
        '/api/sessions',
        json({
          mode: 'step',
          items: [
            { exerciseId: 'algebre-1.1', parts: ['a', 'b'] },
            { exerciseId: 'algebre-1.3', parts: ['a'] },
          ],
        }),
      )
    ).json()) as { id: string };

    const attempt = await app.request(
      '/api/attempts',
      json({ exerciseId: 'algebre-1.1', part: 'a', result: 'ok', sessionId: created.id }),
    );
    expect(attempt.status).toBe(200);
    await app.request(
      '/api/attempts',
      json({ exerciseId: 'algebre-1.1', part: 'b', result: 'ko', sessionId: created.id }),
    );
    await app.request(
      '/api/attempts',
      json({ exerciseId: 'algebre-1.3', part: 'a', result: 'mid', sessionId: created.id }),
    );

    const summaryResponse = await app.request(`/api/sessions/${created.id}/summary`);
    expect(summaryResponse.status).toBe(200);
    const summary = (await summaryResponse.json()) as {
      exercises: { exerciseId: string; result: string; parts: { label: string | null; result: string | null }[] }[];
      errors: { exerciseId: string; part: string | null }[];
      finishedAt: string | null;
    };

    expect(summary.exercises[0]).toEqual({
      exerciseId: 'algebre-1.1',
      result: 'ko',
      parts: [
        { label: 'a', result: 'ok' },
        { label: 'b', result: 'ko' },
      ],
      elapsedMs: 0,
    });
    expect(summary.exercises[1]?.result).toBe('mid');
    expect(summary.errors).toEqual([{ exerciseId: 'algebre-1.1', part: 'b' }]);
    expect(summary.finishedAt).toBeNull();

    const finished = await app.request(`/api/sessions/${created.id}/finish`, json({}));
    expect(finished.status).toBe(200);
    const finishedSummary = (await (await app.request(`/api/sessions/${created.id}/summary`)).json()) as {
      finishedAt: string | null;
    };
    expect(finishedSummary.finishedAt).toEqual(expect.any(String));
  });

  it('garde la dernière auto-évaluation par sous-question', async () => {
    const created = (await (
      await app.request('/api/sessions', json({ mode: 'step', items: [{ exerciseId: 'algebre-1.2', parts: ['a'] }] }))
    ).json()) as { id: string };

    await app.request(
      '/api/attempts',
      json({ exerciseId: 'algebre-1.2', part: 'a', result: 'ko', sessionId: created.id }),
    );
    await app.request(
      '/api/attempts',
      json({ exerciseId: 'algebre-1.2', part: 'a', result: 'ok', sessionId: created.id }),
    );

    const summary = (await (await app.request(`/api/sessions/${created.id}/summary`)).json()) as {
      exercises: { result: string; parts: { result: string | null }[] }[];
      errors: unknown[];
    };
    expect(summary.exercises[0]?.parts[0]?.result).toBe('ok');
    expect(summary.exercises[0]?.result).toBe('ok');
    expect(summary.errors).toEqual([]);
  });
});

describe('catalogue fusionné', () => {
  it('ajoute statut, dernière tentative et vérification à chaque exercice', async () => {
    await app.request('/api/attempts', json({ exerciseId: 'algebre-1.1', part: 'a', result: 'ok' }));
    await app.request('/api/attempts', json({ exerciseId: 'algebre-1.1', part: 'b', result: 'ok' }));
    await app.request('/api/attempts', json({ exerciseId: 'algebre-1.2', part: 'a', result: 'ko' }));
    await app.request('/api/exercises/algebre-1.2/verify', json({ verified: true }));

    const response = await app.request('/api/catalog');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      exercises: { id: string; status: string; lastAttemptAt: string | null; verified: boolean }[];
    };
    const byId = new Map(body.exercises.map((item) => [item.id, item]));

    expect(byId.get('algebre-1.1')?.status).toBe('ok');
    expect(byId.get('algebre-1.1')?.lastAttemptAt).toEqual(expect.any(String));
    expect(byId.get('algebre-1.2')?.status).toBe('ko');
    expect(byId.get('algebre-1.2')?.verified).toBe(true);
    expect(byId.get('algebre-1.3')?.status).toBe('todo');
    expect(byId.get('algebre-1.3')?.lastAttemptAt).toBeNull();
  });

  it('refuse une auto-évaluation sans sous-question, ou sur une sous-question inexistante', async () => {
    expect((await app.request('/api/attempts', json({ exerciseId: 'algebre-1.1', result: 'ok' }))).status).toBe(400);
    expect(
      (await app.request('/api/attempts', json({ exerciseId: 'algebre-1.1', part: 'z', result: 'ok' }))).status,
    ).toBe(400);
    expect(
      (await app.request('/api/attempts', json({ exerciseId: 'algebre-1.1', part: 'a', result: 'peut-être' }))).status,
    ).toBe(400);
    expect((await app.request('/api/attempts', json({ exerciseId: 'algebre-9.9', part: 'a', result: 'ok' }))).status).toBe(
      404,
    );
  });

  it('accepte une auto-évaluation globale pour un exercice sans sous-question', async () => {
    const response = await app.request('/api/attempts', json({ exerciseId: 'algebre-2.4', part: null, result: 'ok' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');

    const catalogResponse = (await (await app.request('/api/catalog')).json()) as {
      exercises: { id: string; status: string }[];
    };
    expect(catalogResponse.exercises.find((item) => item.id === 'algebre-2.4')?.status).toBe('ok');
  });
});

describe('resolve-numbers (API)', () => {
  it('résout une liste mixte et renvoie la suggestion', async () => {
    const response = await app.request(
      '/api/resolve-numbers',
      json({ subject: 'algebre', input: '1.3–1.8, 2.4, 1.93' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { found: string[]; unknown: { token: string; suggestion: string }[] };
    expect(body.found).toHaveLength(7);
    expect(body.unknown).toEqual([{ token: '1.93', suggestion: '1.9' }]);
  });

  it('refuse une matière inconnue et une saisie vide', async () => {
    expect((await app.request('/api/resolve-numbers', json({ subject: 'chimie', input: '1.1' }))).status).toBe(400);
    expect((await app.request('/api/resolve-numbers', json({ subject: 'algebre', input: '  ' }))).status).toBe(400);
  });
});

describe('vérification et découpes', () => {
  it('enregistre la vérification d’un exercice', async () => {
    const response = await app.request('/api/exercises/algebre-1.1/verify', json({ verified: true }));
    expect(response.status).toBe(200);
    const detail = (await (await app.request('/api/exercises/algebre-1.1')).json()) as {
      exercise: { verified: boolean };
    };
    expect(detail.exercise.verified).toBe(true);
  });

  it('renvoie l’exercice fusionné avec ses emplacements manuels', async () => {
    const detail = (await (await app.request('/api/exercises/algebre-1.1')).json()) as {
      exercise: { id: string; manualSlots: string[]; statement: { src: string }[] };
    };
    expect(detail.exercise.id).toBe('algebre-1.1');
    expect(detail.exercise.manualSlots).toEqual([]);
    expect(detail.exercise.statement[0]?.src).toBe('crops/algebre-1.1-statement-0.png');
  });
});

describe('images', () => {
  it('sert les découpes depuis DATA_DIR avec un cache long', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'matudrill-crops-'));
    mkdirSync(join(dir, 'crops'), { recursive: true });
    // PNG 1×1 transparent.
    writeFileSync(
      join(dir, 'crops', 'test.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const croppedApp = createApp({ getCatalog: () => catalog, store, dataDir: dir });

    const response = await croppedApp.request('/crops/test.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(response.headers.get('cache-control')).toContain('max-age');

    const missing = await croppedApp.request('/crops/absent.png');
    expect(missing.status).not.toBe(500);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('catalogue de test', () => {
  it('expose les matières et les sections', async () => {
    const body = (await (await app.request('/api/catalog')).json()) as {
      subjects: { id: string }[];
      sections: { id: string }[];
    };
    expect(body.subjects.map((subject) => subject.id)).toEqual(['algebre', 'physique']);
    expect(body.sections.length).toBeGreaterThan(0);
    expect(crop('x').src).toBe('crops/x.png');
  });
});

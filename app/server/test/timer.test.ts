import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createApp } from '../src/app.js';
import { Store } from '../src/db.js';
import type { Catalog } from '../src/types.js';
import { exercise, makeCatalog, part } from './helpers.js';

/** 6 h : plafond d'un temps d'exercice. */
const MAX_MS = 6 * 60 * 60 * 1000;

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

async function createSession(items: { exerciseId: string; parts: string[] }[], mode = 'step'): Promise<string> {
  const response = await app.request('/api/sessions', json({ mode, items }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

interface ItemTime {
  exerciseId: string;
  elapsedMs: number;
}

interface SessionBody {
  items: ItemTime[];
  totalElapsedMs: number;
}

beforeEach(() => {
  catalog = makeCatalog([
    exercise('1.1', { parts: [part('a'), part('b')] }),
    exercise('1.2', { parts: [part('a'), part('b')] }),
    exercise('1.3', { parts: [part('a')] }),
  ]);
  store = new Store(':memory:');
  app = createApp({
    getCatalog: () => catalog,
    store,
    dataDir: '/tmp/matudrill-test',
    appDataDir: '/tmp/matudrill-test/app-data',
  });
});

describe('migration du chronomètre', () => {
  it('ajoute elapsed_ms à une base qui ne l’a pas, sans perdre les sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'matudrill-migration-'));
    const file = join(dir, 'matudrill.db');

    // Base « de production » : session_items sans la colonne du chronomètre.
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('step', 'all')),
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE session_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        exercise_id TEXT NOT NULL,
        parts TEXT NOT NULL,
        position INTEGER NOT NULL
      );
      INSERT INTO sessions (id, mode, created_at) VALUES ('ses_old', 'step', '2026-11-20T10:00:00Z');
      INSERT INTO session_items (session_id, exercise_id, parts, position)
        VALUES ('ses_old', 'algebre-1.1', '["a"]', 0);
    `);
    legacy.close();

    // Première ouverture : la colonne manque, elle est ajoutée.
    const first = new Store(file);
    expect(first.getSession('ses_old')).toEqual({
      id: 'ses_old',
      mode: 'step',
      createdAt: '2026-11-20T10:00:00Z',
      finishedAt: null,
      totalElapsedMs: 0,
      items: [{ exerciseId: 'algebre-1.1', parts: ['a'], position: 0, elapsedMs: 0 }],
    });
    first.setSessionItemElapsed('ses_old', 'algebre-1.1', 42_000);
    first.close();

    // Seconde ouverture : rien à faire, les temps sont conservés.
    const second = new Store(file);
    expect(second.getSession('ses_old')?.items[0]?.elapsedMs).toBe(42_000);
    expect(second.getSession('ses_old')?.totalElapsedMs).toBe(42_000);
    second.close();

    const check = new Database(file, { readonly: true });
    const columns = check.prepare('PRAGMA table_info(session_items)').all() as { name: string }[];
    check.close();
    expect(columns.filter((column) => column.name === 'elapsed_ms')).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('PUT /api/sessions/:id/items/:exerciseId/time', () => {
  it('enregistre le temps cumulé et le renvoie avec le total', async () => {
    const sessionId = await createSession([
      { exerciseId: 'algebre-1.1', parts: ['a', 'b'] },
      { exerciseId: 'algebre-1.2', parts: ['a'] },
    ]);

    const response = await app.request(
      `/api/sessions/${sessionId}/items/algebre-1.1/time`,
      json({ elapsedMs: 65_000 }, 'PUT'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; item: ItemTime; totalElapsedMs: number };
    expect(body.ok).toBe(true);
    expect(body.item).toEqual({ exerciseId: 'algebre-1.1', parts: ['a', 'b'], position: 0, elapsedMs: 65_000 });
    expect(body.totalElapsedMs).toBe(65_000);

    const session = (await (await app.request(`/api/sessions/${sessionId}`)).json()) as SessionBody;
    expect(session.items.map((item) => item.elapsedMs)).toEqual([65_000, 0]);
    expect(session.totalElapsedMs).toBe(65_000);
  });

  it('refuse un temps négatif ou absent', async () => {
    const sessionId = await createSession([{ exerciseId: 'algebre-1.1', parts: ['a'] }]);
    const path = `/api/sessions/${sessionId}/items/algebre-1.1/time`;

    expect((await app.request(path, json({ elapsedMs: -1 }, 'PUT'))).status).toBe(400);
    expect((await app.request(path, json({ elapsedMs: '60' }, 'PUT'))).status).toBe(400);
    expect((await app.request(path, json({}, 'PUT'))).status).toBe(400);
    expect((await app.request(path, json(null, 'PUT'))).status).toBe(400);
  });

  it('plafonne à 6 h', async () => {
    const sessionId = await createSession([{ exerciseId: 'algebre-1.1', parts: ['a'] }]);
    const response = await app.request(
      `/api/sessions/${sessionId}/items/algebre-1.1/time`,
      json({ elapsedMs: 9 * 60 * 60 * 1000 }, 'PUT'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { item: ItemTime };
    expect(body.item.elapsedMs).toBe(MAX_MS);
  });

  it('refuse une baisse de plus de 2 s et garde le temps le plus grand', async () => {
    const sessionId = await createSession([{ exerciseId: 'algebre-1.1', parts: ['a'] }]);
    const path = `/api/sessions/${sessionId}/items/algebre-1.1/time`;

    await app.request(path, json({ elapsedMs: 60_000 }, 'PUT'));

    // 2 s de baisse : toléré (deux onglets qui se chevauchent).
    expect((await app.request(path, json({ elapsedMs: 58_000 }, 'PUT'))).status).toBe(200);

    // 2,001 s de baisse : refusé, la valeur enregistrée ne bouge pas.
    const refused = await app.request(path, json({ elapsedMs: 50_000 }, 'PUT'));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('plus court');

    const session = (await (await app.request(`/api/sessions/${sessionId}`)).json()) as SessionBody;
    expect(session.items[0]?.elapsedMs).toBe(58_000);
  });

  it('renvoie 404 pour une session ou un exercice hors session', async () => {
    const sessionId = await createSession([{ exerciseId: 'algebre-1.1', parts: ['a'] }]);
    expect(
      (await app.request('/api/sessions/ses_inconnue/items/algebre-1.1/time', json({ elapsedMs: 1000 }, 'PUT'))).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/sessions/${sessionId}/items/algebre-1.3/time`, json({ elapsedMs: 1000 }, 'PUT'))).status,
    ).toBe(404);
  });
});

describe('temps dans le résumé et le catalogue', () => {
  it('le résumé renvoie elapsedMs par exercice et totalElapsedMs', async () => {
    const sessionId = await createSession([
      { exerciseId: 'algebre-1.1', parts: ['a', 'b'] },
      { exerciseId: 'algebre-1.2', parts: ['a'] },
    ]);
    await app.request(
      `/api/sessions/${sessionId}/items/algebre-1.1/time`,
      json({ elapsedMs: 271_000 }, 'PUT'),
    );
    await app.request(`/api/sessions/${sessionId}/items/algebre-1.2/time`, json({ elapsedMs: 29_000 }, 'PUT'));

    const summary = (await (await app.request(`/api/sessions/${sessionId}/summary`)).json()) as {
      exercises: { exerciseId: string; elapsedMs: number }[];
      totalElapsedMs: number;
    };
    expect(summary.exercises.map((exercise) => [exercise.exerciseId, exercise.elapsedMs])).toEqual([
      ['algebre-1.1', 271_000],
      ['algebre-1.2', 29_000],
    ]);
    expect(summary.totalElapsedMs).toBe(300_000);
  });

  it('le catalogue expose lastElapsedMs du dernier passage terminé', async () => {
    const before = (await (await app.request('/api/catalog')).json()) as {
      exercises: { id: string; lastElapsedMs: number | null }[];
    };
    expect(before.exercises.every((exercise) => exercise.lastElapsedMs === null)).toBe(true);

    const sessionId = await createSession([
      { exerciseId: 'algebre-1.1', parts: ['a'] },
      { exerciseId: 'algebre-1.2', parts: ['a'] },
    ]);
    await app.request(`/api/sessions/${sessionId}/items/algebre-1.1/time`, json({ elapsedMs: 90_000 }, 'PUT'));

    // Session encore ouverte : rien n'est publié dans la bibliothèque.
    const running = (await (await app.request('/api/catalog')).json()) as {
      exercises: { id: string; lastElapsedMs: number | null }[];
    };
    expect(running.exercises.find((exercise) => exercise.id === 'algebre-1.1')?.lastElapsedMs).toBeNull();

    await app.request(`/api/sessions/${sessionId}/finish`, json({}));

    const after = (await (await app.request('/api/catalog')).json()) as {
      exercises: { id: string; lastElapsedMs: number | null }[];
    };
    const byId = new Map(after.exercises.map((exercise) => [exercise.id, exercise.lastElapsedMs]));
    expect(byId.get('algebre-1.1')).toBe(90_000);
    expect(byId.get('algebre-1.2')).toBeNull();
    expect(byId.get('algebre-1.3')).toBeNull();
  });
});

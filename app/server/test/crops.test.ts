import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { Store } from '../src/db.js';
import { readPngSize } from '../src/pdf.js';
import type { Catalog } from '../src/types.js';
import { crop, exercise, makeCatalog, part } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDFS_DIR = resolve(HERE, '../../../pdfs');
const ALGEBRE_PDF = join(PDFS_DIR, 'algebre.pdf');

/** La page 13 du polycopié d'algèbre et l'énoncé de l'exercice 1.1. */
const RECT: [number, number, number, number] = [40, 116, 555, 396];
const EXPECTED_W = 1073;
const EXPECTED_H = 583;

const tempDirs: string[] = [];
let store: Store;
let appDataDir: string;
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
  appDataDir = mkdtempSync(join(tmpdir(), 'matudrill-crops-'));
  tempDirs.push(appDataDir);

  catalog = makeCatalog([
    exercise('1.1', { parts: [part('a'), part('b'), part('c', false)] }),
    exercise('1.2', { parts: [part('a')] }),
  ]);
  store = new Store(join(appDataDir, 'matudrill.db'));
  app = createApp({
    getCatalog: () => catalog,
    store,
    dataDir: join(appDataDir, 'data'),
    pdfsDir: PDFS_DIR,
    appDataDir,
  });
});

afterAll(() => {
  store?.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/pdf/:subject/pages/:n', () => {
  it.runIf(existsSync(ALGEBRE_PDF))('rend la page 13 en A4 à 200 dpi et la sert depuis /pdf-pages', async () => {
    const response = await app.request('/api/pdf/algebre/pages/13');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      page: number;
      widthPt: number;
      heightPt: number;
      dpi: number;
      image: string;
    };

    expect(body.page).toBe(13);
    expect(body.widthPt).toBeCloseTo(595.28, 1);
    expect(body.heightPt).toBeCloseTo(841.89, 1);
    expect(body.dpi).toBe(200);
    // Le nom du fichier porte le dpi : un cache à 110 dpi ne peut pas être servi.
    expect(body.image).toBe('/pdf-pages/algebre-13-200dpi.png');

    const image = await app.request(body.image);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toContain('image/png');
    expect(image.headers.get('cache-control')).toContain('max-age');

    const size = readPngSize(join(appDataDir, 'pages', 'algebre-13-200dpi.png'));
    // 200 dpi : 595,28 pt × 200/72 ≈ 1654 px.
    expect(size.w).toBeGreaterThan(1640);
    expect(size.w).toBeLessThan(1670);
  });

  it('refuse une matière inconnue et une page hors bornes', async () => {
    expect((await app.request('/api/pdf/chimie/pages/1')).status).toBe(400);
    expect((await app.request('/api/pdf/algebre/pages/0')).status).toBe(400);
    expect((await app.request('/api/pdf/algebre/pages/999')).status).toBe(400);
    expect((await app.request('/api/pdf/algebre/pages/treize')).status).toBe(400);
  });
});

describe('PUT /api/exercises/:id/crops/:slot', () => {
  it.runIf(existsSync(ALGEBRE_PDF))('rend la découpe réelle à 150 dpi (1073 × 583 px)', async () => {
    const response = await app.request(
      '/api/exercises/algebre-1.1/crops/statement:0',
      json({ page: 13, rect: RECT }, 'PUT'),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      slot: string;
      image: { src: string; w: number; h: number; page: number; rect: number[]; manual: boolean };
      manualSlots: string[];
      exercise: { statement: { src: string; manual?: boolean }[] };
    };

    expect(body.ok).toBe(true);
    expect(body.slot).toBe('statement:0');
    expect(body.image.w).toBeGreaterThanOrEqual(EXPECTED_W - 2);
    expect(body.image.w).toBeLessThanOrEqual(EXPECTED_W + 2);
    expect(body.image.h).toBeGreaterThanOrEqual(EXPECTED_H - 2);
    expect(body.image.h).toBeLessThanOrEqual(EXPECTED_H + 2);
    expect(body.image.page).toBe(13);
    expect(body.image.rect).toEqual(RECT);
    expect(body.image.manual).toBe(true);
    expect(body.image.src).toMatch(/^crops-override\/algebre-1\.1__statement-0__\d+\.png$/);
    expect(body.manualSlots).toEqual(['statement:0']);

    // Le fichier existe vraiment et fait la taille annoncée.
    const file = join(appDataDir, body.image.src);
    expect(existsSync(file)).toBe(true);
    expect(readPngSize(file)).toEqual({ w: body.image.w, h: body.image.h });

    const served = await app.request(`/${body.image.src}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('image/png');
  });

  it.runIf(existsSync(ALGEBRE_PDF))('change le nom de fichier à chaque enregistrement', async () => {
    const first = (await (
      await app.request('/api/exercises/algebre-1.1/crops/statement:0', json({ page: 13, rect: RECT }, 'PUT'))
    ).json()) as { image: { src: string } };
    const second = (await (
      await app.request(
        '/api/exercises/algebre-1.1/crops/statement:0',
        json({ page: 13, rect: [40, 116, 555, 397] }, 'PUT'),
      )
    ).json()) as { image: { src: string } };

    expect(first.image.src).not.toBe(second.image.src);
    expect(store.getCropSlots('algebre-1.1')).toHaveLength(1);
    // L'ancien PNG ne traîne pas : un seul fichier par emplacement.
    expect(existsSync(join(appDataDir, first.image.src))).toBe(false);
    expect(existsSync(join(appDataDir, second.image.src))).toBe(true);
  });

  it('refuse un cadre hors de la page, une page hors bornes et un emplacement inconnu', async () => {
    const outside = await app.request(
      '/api/exercises/algebre-1.1/crops/statement:0',
      json({ page: 13, rect: [40, 116, 700, 396] }, 'PUT'),
    );
    expect(outside.status).toBe(400);

    const negative = await app.request(
      '/api/exercises/algebre-1.1/crops/statement:0',
      json({ page: 13, rect: [-10, 116, 200, 396] }, 'PUT'),
    );
    expect(negative.status).toBe(400);

    const tiny = await app.request(
      '/api/exercises/algebre-1.1/crops/statement:0',
      json({ page: 13, rect: [40, 116, 44, 396] }, 'PUT'),
    );
    expect(tiny.status).toBe(400);

    const reversed = await app.request(
      '/api/exercises/algebre-1.1/crops/statement:0',
      json({ page: 13, rect: [555, 116, 40, 396] }, 'PUT'),
    );
    expect(reversed.status).toBe(400);

    const badPage = await app.request(
      '/api/exercises/algebre-1.1/crops/statement:0',
      json({ page: 999, rect: RECT }, 'PUT'),
    );
    expect(badPage.status).toBe(400);

    const badSlot = await app.request(
      '/api/exercises/algebre-1.1/crops/answer:z',
      json({ page: 13, rect: RECT }, 'PUT'),
    );
    expect(badSlot.status).toBe(400);

    const badKind = await app.request(
      '/api/exercises/algebre-1.1/crops/statement:abc',
      json({ page: 13, rect: RECT }, 'PUT'),
    );
    expect(badKind.status).toBe(400);

    const unknownExercise = await app.request(
      '/api/exercises/algebre-9.9/crops/statement:0',
      json({ page: 13, rect: RECT }, 'PUT'),
    );
    expect(unknownExercise.status).toBe(404);

    expect(store.getCropSlots('algebre-1.1')).toHaveLength(0);
  });

  it('refuse un corps de requête sans page ni cadre', async () => {
    expect(
      (await app.request('/api/exercises/algebre-1.1/crops/statement:0', json({ rect: RECT }, 'PUT'))).status,
    ).toBe(400);
    expect(
      (await app.request('/api/exercises/algebre-1.1/crops/statement:0', json({ page: 13 }, 'PUT'))).status,
    ).toBe(400);
    expect(
      (await app.request('/api/exercises/algebre-1.1/crops/statement:0', json({ page: 13, rect: [1, 2] }, 'PUT')))
        .status,
    ).toBe(400);
  });
});

describe('fusion des découpes manuelles', () => {
  it.runIf(existsSync(ALGEBRE_PDF))('remplace src/w/h/page/rect et marque l’image manual', async () => {
    await app.request('/api/exercises/algebre-1.1/crops/statement:0', json({ page: 13, rect: RECT }, 'PUT'));

    const body = (await (await app.request('/api/catalog')).json()) as {
      exercises: {
        id: string;
        manualSlots: string[];
        statement: { src: string; w: number; h: number; page: number; rect: number[]; manual: boolean }[];
      }[];
    };
    const target = body.exercises.find((item) => item.id === 'algebre-1.1')!;

    expect(target.manualSlots).toEqual(['statement:0']);
    expect(target.statement[0]?.src).toMatch(/^crops-override\//);
    expect(target.statement[0]?.src).not.toBe('crops/algebre-1.1-statement-0.png');
    expect(target.statement[0]?.manual).toBe(true);
    expect(target.statement[0]?.page).toBe(13);
    expect(target.statement[0]?.rect).toEqual(RECT);
    expect(target.statement[0]?.w).toBeGreaterThanOrEqual(EXPECTED_W - 2);

    // Les exercices sans override gardent leur découpe automatique.
    const other = body.exercises.find((item) => item.id === 'algebre-1.2')!;
    expect(other.manualSlots).toEqual([]);
    expect(other.statement[0]?.src).toBe('crops/algebre-1.2-statement-0.png');
  });

  it.runIf(existsSync(ALGEBRE_PDF))('crée l’image d’une réponse absente', async () => {
    const response = await app.request(
      '/api/exercises/algebre-1.1/crops/answer:c',
      json({ page: 183, rect: [60, 200, 500, 260] }, 'PUT'),
    );
    expect(response.status).toBe(200);

    const body = (await (await app.request('/api/catalog')).json()) as {
      exercises: {
        id: string;
        manualSlots: string[];
        parts: { label: string; answer: { src: string; manual: boolean } | null }[];
      }[];
    };
    const target = body.exercises.find((item) => item.id === 'algebre-1.1')!;
    const answer = target.parts.find((item) => item.label === 'c')?.answer;

    expect(answer).not.toBeNull();
    expect(answer?.src).toMatch(/^crops-override\/algebre-1\.1__answer-c__\d+\.png$/);
    expect(answer?.manual).toBe(true);
    expect(target.manualSlots).toEqual(['answer:c']);
  });

  it.runIf(existsSync(ALGEBRE_PDF))('renvoie l’exercice fusionné dans la réponse du PUT et du DELETE', async () => {
    const put = (await (
      await app.request(
        '/api/exercises/algebre-1.1/crops/question:a',
        json({ page: 13, rect: [40, 116, 555, 396] }, 'PUT'),
      )
    ).json()) as { exercise: { parts: { label: string; question: { src: string } }[] } };
    expect(put.exercise.parts[0]?.question.src).toMatch(/^crops-override\//);

    const detail = (await (await app.request('/api/exercises/algebre-1.1')).json()) as {
      exercise: { manualSlots: string[]; parts: { label: string; question: { src: string } }[] };
    };
    expect(detail.exercise.manualSlots).toEqual(['question:a']);
    expect(detail.exercise.parts[0]?.question.src).toMatch(/^crops-override\//);
  });

  it.runIf(existsSync(ALGEBRE_PDF))('revient à la découpe automatique après DELETE', async () => {
    await app.request('/api/exercises/algebre-1.1/crops/statement:0', json({ page: 13, rect: RECT }, 'PUT'));

    const before = (await (await app.request('/api/catalog')).json()) as {
      exercises: { id: string; statement: { src: string }[] }[];
    };
    const file = join(
      appDataDir,
      before.exercises.find((item) => item.id === 'algebre-1.1')!.statement[0]!.src,
    );
    expect(existsSync(file)).toBe(true);

    const removed = await app.request('/api/exercises/algebre-1.1/crops/statement:0', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(existsSync(file)).toBe(false);

    const body = (await (await app.request('/api/catalog')).json()) as {
      exercises: {
        id: string;
        manualSlots: string[];
        statement: { src: string; manual?: boolean; rect?: number[] }[];
      }[];
    };
    const target = body.exercises.find((item) => item.id === 'algebre-1.1')!;
    expect(target.manualSlots).toEqual([]);
    expect(target.statement[0]?.src).toBe('crops/algebre-1.1-statement-0.png');
    expect(target.statement[0]?.manual).toBeUndefined();
    expect(target.statement[0]?.rect).toBeUndefined();
    expect(store.getCropSlots('algebre-1.1')).toHaveLength(0);
  });

  it('refuse un emplacement inconnu à la suppression', async () => {
    expect((await app.request('/api/exercises/algebre-1.1/crops/question:z', { method: 'DELETE' })).status).toBe(
      400,
    );
    expect((await app.request('/api/exercises/algebre-9.9/crops/statement:0', { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});

describe('store des découpes', () => {
  it('garde une seule ligne par (exercice, emplacement)', () => {
    mkdirSync(join(appDataDir, 'pages'), { recursive: true });
    for (const y of [100, 120, 140]) {
      store.saveCropSlot({
        exerciseId: 'algebre-1.1',
        slot: 'statement:0',
        page: 13,
        x0: 40,
        y0: y,
        x1: 555,
        y1: 396,
        src: `crops-override/test-${y}.png`,
        w: 100,
        h: 50,
      });
    }
    store.saveCropSlot({
      exerciseId: 'algebre-1.1',
      slot: 'answer:a',
      page: 183,
      x0: 10,
      y0: 10,
      x1: 200,
      y1: 60,
      src: 'crops-override/test-answer.png',
      w: 100,
      h: 50,
    });

    const rows = store.getCropSlots('algebre-1.1');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.slot).toBe('answer:a');
    expect(rows[1]?.slot).toBe('statement:0');
    expect(rows[1]?.y0).toBe(140);
    expect(store.getAllCropSlots()).toHaveLength(2);

    store.deleteCropSlot('algebre-1.1', 'statement:0');
    expect(store.getCropSlots('algebre-1.1').map((row) => row.slot)).toEqual(['answer:a']);
    expect(crop('x').src).toBe('crops/x.png');
  });
});

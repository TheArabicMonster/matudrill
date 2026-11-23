import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { applyCropOverrides, lookupSlot, parseSlot } from './crops.js';
import { Store } from './db.js';
import { PAGE_DPI, PdfError, PdfService } from './pdf.js';
import { resolveNumbers } from './resolve-numbers.js';
import { deriveStatus } from './status.js';
import type {
  AttemptInput,
  Catalog,
  Crop,
  CropOverride,
  Exercise,
  Rect,
  ResultValue,
  SessionItemInput,
  SessionMode,
  Status,
} from './types.js';

export interface AppDeps {
  getCatalog: () => Catalog;
  store: Store;
  dataDir: string;
  /** Dossier des PDF sources ; défaut : à côté de `DATA_DIR`. */
  pdfsDir?: string;
  /** Base, overrides et pages rendues ; défaut : à côté de `DATA_DIR`. */
  appDataDir?: string;
  /** Dossier du front compilé. Absent en test : l'API seule est servie. */
  webDist?: string;
}

type MergedExercise = Exercise & {
  status: Status;
  lastAttemptAt: string | null;
  /** Temps du dernier passage terminé, null s'il n'y en a jamais eu. */
  lastElapsedMs: number | null;
  verified: boolean;
  manualSlots: string[];
};

const RESULTS: ResultValue[] = ['ok', 'mid', 'ko'];

/** Taille minimale d'une découpe, en points PDF. */
const MIN_CROP_PT = 8;

/** Plafond d'un temps d'exercice : 6 h, au-delà c'est un onglet resté ouvert. */
const MAX_ELAPSED_MS = 6 * 60 * 60 * 1000;

/** Une baisse de plus de 2 s vient d'un onglet plus ancien : on la refuse. */
const MAX_DECREASE_MS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRect(value: unknown): Rect | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
  const [x0, y0, x1, y1] = value as Rect;
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const json = await c.req.json();
    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

function invalid(c: Context, message: string) {
  return c.json({ error: message }, 400);
}

function notFound(c: Context, message: string) {
  return c.json({ error: message }, 404);
}

function pdfFailure(c: Context, error: unknown) {
  if (error instanceof PdfError) {
    if (error.status === 400) return invalid(c, error.message);
    return c.json({ error: error.message }, 500);
  }
  console.error('[matudrill] rendu PDF impossible', error);
  return c.json({ error: 'Le rendu du PDF a échoué. Réessaie.' }, 500);
}

function groupOverrides(overrides: CropOverride[]): Map<string, CropOverride[]> {
  const byExercise = new Map<string, CropOverride[]>();
  for (const row of overrides) {
    const list = byExercise.get(row.exerciseId) ?? [];
    list.push(row);
    byExercise.set(row.exerciseId, list);
  }
  return byExercise;
}

function mergeExercises(catalog: Catalog, store: Store): MergedExercise[] {
  const latest = store.getLatestResults();
  const verified = store.getVerifiedIds();
  const overrides = groupOverrides(store.getAllCropSlots());
  const lastElapsed = store.getLastElapsed();

  const byExercise = new Map<string, { results: ResultValue[]; lastAttemptAt: string | null }>();
  for (const row of latest) {
    const entry = byExercise.get(row.exerciseId) ?? { results: [], lastAttemptAt: null };
    entry.results.push(row.result);
    if (!entry.lastAttemptAt || row.createdAt > entry.lastAttemptAt) entry.lastAttemptAt = row.createdAt;
    byExercise.set(row.exerciseId, entry);
  }

  return catalog.exercises.map((exercise) => {
    const entry = byExercise.get(exercise.id);
    const merged = applyCropOverrides(exercise, overrides.get(exercise.id) ?? []);
    return {
      ...merged,
      manualSlots: merged.manualSlots ?? [],
      status: entry ? deriveStatus(entry.results) : 'todo',
      lastAttemptAt: entry?.lastAttemptAt ?? null,
      lastElapsedMs: lastElapsed.get(exercise.id) ?? null,
      verified: verified.has(exercise.id) || exercise.verified === true,
    };
  });
}

function mergedExercise(catalog: Catalog, store: Store, id: string): MergedExercise | null {
  return mergeExercises(catalog, store).find((item) => item.id === id) ?? null;
}

function exerciseStatusAfterAttempt(store: Store, exercise: Exercise): Status {
  const rows = store.getLatestResults().filter((row) => row.exerciseId === exercise.id);
  return deriveStatus(rows.map((row) => row.result));
}

export function createApp(deps: AppDeps): Hono {
  const { getCatalog, store, dataDir } = deps;
  const appDataDir = deps.appDataDir ?? resolve(dataDir, '..', 'app-data');
  const pdfsDir = deps.pdfsDir ?? resolve(dataDir, '..', 'pdfs');
  for (const dir of [join(appDataDir, 'pages'), join(appDataDir, 'crops-override')]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      console.error(`[matudrill] dossier inaccessible : ${dir}`, error);
    }
  }
  const pdf = new PdfService({
    pdfsDir,
    pagesDir: join(appDataDir, 'pages'),
    cropsOverrideDir: join(appDataDir, 'crops-override'),
  });
  const app = new Hono();

  app.onError((error, c) => {
    console.error('[matudrill] erreur serveur', error);
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Erreur du serveur. Réessaie.' }, 500);
    }
    return c.text('Erreur du serveur', 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/catalog', (c) => {
    const catalog = getCatalog();
    return c.json({ ...catalog, exercises: mergeExercises(catalog, store) });
  });

  app.get('/api/exercises/:id', (c) => {
    const catalog = getCatalog();
    const exercise = catalog.exercises.find((item) => item.id === c.req.param('id'));
    if (!exercise) return notFound(c, 'Exercice inconnu.');
    const merged = mergedExercise(catalog, store, exercise.id)!;
    return c.json({ exercise: merged });
  });

  app.post('/api/attempts', async (c) => {
    const body = await readBody(c);
    if (!body) return invalid(c, 'Corps de requête invalide.');

    const exerciseId = typeof body.exerciseId === 'string' ? body.exerciseId : '';
    const catalog = getCatalog();
    const exercise = catalog.exercises.find((item) => item.id === exerciseId);
    if (!exercise) return notFound(c, 'Exercice inconnu.');

    const result = body.result;
    if (typeof result !== 'string' || !RESULTS.includes(result as ResultValue)) {
      return invalid(c, 'Résultat attendu : ok, mid ou ko.');
    }

    const rawPart = body.part;
    let part: string | null = null;
    if (rawPart !== null && rawPart !== undefined) {
      if (typeof rawPart !== 'string') return invalid(c, 'Sous-question invalide.');
      if (!exercise.parts.some((item) => item.label === rawPart)) {
        return invalid(c, `L'exercice ${exercise.number} n'a pas de sous-question « ${rawPart} ».`);
      }
      part = rawPart;
    } else if (exercise.parts.length > 0) {
      return invalid(c, `Précise la sous-question de l'exercice ${exercise.number}.`);
    }

    let sessionId: string | null = null;
    if (body.sessionId !== null && body.sessionId !== undefined) {
      if (typeof body.sessionId !== 'string') return invalid(c, 'Session invalide.');
      if (!store.getSession(body.sessionId)) return notFound(c, 'Session inconnue.');
      sessionId = body.sessionId;
    }

    const attempt: AttemptInput = { exerciseId, part, result: result as ResultValue, sessionId };
    store.addAttempt(attempt);

    return c.json({
      ok: true,
      exerciseId,
      part,
      result,
      status: exerciseStatusAfterAttempt(store, exercise),
    });
  });

  app.post('/api/sessions', async (c) => {
    const body = await readBody(c);
    if (!body) return invalid(c, 'Corps de requête invalide.');

    const mode = body.mode;
    if (mode !== 'step' && mode !== 'all') return invalid(c, 'Mode attendu : step ou all.');

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return invalid(c, 'Ajoute au moins un exercice à la session.');
    }

    const catalog = getCatalog();
    const items: SessionItemInput[] = [];

    for (const raw of body.items) {
      if (!isRecord(raw) || typeof raw.exerciseId !== 'string') {
        return invalid(c, 'Exercice invalide dans la session.');
      }
      const exercise = catalog.exercises.find((item) => item.id === raw.exerciseId);
      if (!exercise) return notFound(c, `Exercice inconnu : ${raw.exerciseId}.`);

      const rawParts = Array.isArray(raw.parts) ? raw.parts : [];
      const parts = rawParts.filter(
        (part): part is string => typeof part === 'string' && exercise.parts.some((item) => item.label === part),
      );

      if (exercise.parts.length > 0 && parts.length === 0) {
        return invalid(c, `Choisis au moins une sous-question pour l'exercice ${exercise.number}.`);
      }
      items.push({ exerciseId: exercise.id, parts });
    }

    const session = store.createSession(mode as SessionMode, items);
    return c.json({ id: session.id, mode: session.mode, createdAt: session.createdAt }, 201);
  });

  app.get('/api/sessions/:id', (c) => {
    const session = store.getSession(c.req.param('id'));
    if (!session) return notFound(c, 'Session inconnue.');
    return c.json(session);
  });

  app.post('/api/sessions/:id/finish', (c) => {
    const session = store.finishSession(c.req.param('id'));
    if (!session) return notFound(c, 'Session inconnue.');
    return c.json({ ok: true, session });
  });

  app.get('/api/sessions/:id/summary', (c) => {
    const summary = store.getSessionSummary(c.req.param('id'));
    if (!summary) return notFound(c, 'Session inconnue.');
    return c.json(summary);
  });

  /**
   * Chronomètre par exercice : le temps cumulé est envoyé par le client
   * (performance.now()) et ne peut que grandir, sauf dérive de 2 s.
   */
  app.put('/api/sessions/:id/items/:exerciseId/time', async (c) => {
    const sessionId = c.req.param('id');
    if (!store.getSession(sessionId)) return notFound(c, 'Session inconnue.');

    const exerciseId = c.req.param('exerciseId');
    const item = store.getSessionItem(sessionId, exerciseId);
    if (!item) return notFound(c, 'Cet exercice ne fait pas partie de la session.');

    const body = await readBody(c);
    if (!body) return invalid(c, 'Corps de requête invalide.');

    const raw = body.elapsedMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      return invalid(c, 'Temps attendu en millisecondes (nombre ≥ 0).');
    }

    const elapsedMs = Math.min(Math.round(raw), MAX_ELAPSED_MS);
    if (elapsedMs < item.elapsedMs - MAX_DECREASE_MS) {
      return c.json(
        {
          error: 'Ce temps est plus court que celui déjà enregistré. Recharge la page pour repartir du bon temps.',
        },
        409,
      );
    }

    store.setSessionItemElapsed(sessionId, exerciseId, elapsedMs);
    const updated = store.getSessionItem(sessionId, exerciseId)!;
    return c.json({
      ok: true,
      item: updated,
      totalElapsedMs: store.getSessionTotalElapsed(sessionId),
    });
  });

  app.post('/api/resolve-numbers', async (c) => {
    const body = await readBody(c);
    if (!body) return invalid(c, 'Corps de requête invalide.');

    const subject = typeof body.subject === 'string' ? body.subject : '';
    const input = typeof body.input === 'string' ? body.input : '';
    const catalog = getCatalog();

    if (!subject) return invalid(c, 'Précise la matière.');
    if (!catalog.subjects.some((item) => item.id === subject) && !catalog.exercises.some((item) => item.subject === subject)) {
      return invalid(c, 'Matière inconnue.');
    }
    if (input.trim().length === 0) return invalid(c, 'Saisis au moins un numéro.');

    return c.json(resolveNumbers(catalog, subject, input));
  });

  app.post('/api/exercises/:id/verify', async (c) => {
    const catalog = getCatalog();
    const exercise = catalog.exercises.find((item) => item.id === c.req.param('id'));
    if (!exercise) return notFound(c, 'Exercice inconnu.');

    const body = await readBody(c);
    if (!body) return invalid(c, 'Corps de requête invalide.');
    if (typeof body.verified !== 'boolean') return invalid(c, 'Champ « verified » attendu (true ou false).');

    store.setVerified(exercise.id, body.verified);
    return c.json({ ok: true, exerciseId: exercise.id, verified: body.verified });
  });

  // Page d'un polycopié, rendue à `PAGE_DPI` pour l'éditeur de recadrage.
  app.get('/api/pdf/:subject/pages/:n', async (c) => {
    const catalog = getCatalog();
    const subject = catalog.subjects.find((item) => item.id === c.req.param('subject'));
    if (!subject) return invalid(c, 'Matière inconnue.');

    const rawPage = c.req.param('n');
    if (!/^\d{1,4}$/.test(rawPage)) return invalid(c, 'Numéro de page invalide.');
    const page = Number(rawPage);

    try {
      const pdfPath = pdf.pdfPath(subject.pdf);
      const metrics = await pdf.checkPage(pdfPath, page, subject.pages);
      const name = await pdf.pageImage(subject.id, pdfPath, page);
      return c.json({
        page,
        widthPt: metrics.widthPt,
        heightPt: metrics.heightPt,
        dpi: PAGE_DPI,
        image: `/pdf-pages/${name}`,
      });
    } catch (error) {
      return pdfFailure(c, error);
    }
  });

  // Recadrage manuel : une découpe re-rendue depuis le PDF pour tout le monde.
  app.put('/api/exercises/:id/crops/:slot', async (c) => {
    const catalog = getCatalog();
    const exercise = catalog.exercises.find((item) => item.id === c.req.param('id'));
    if (!exercise) return notFound(c, 'Exercice inconnu.');

    const slotRaw = c.req.param('slot');
    const slot = parseSlot(slotRaw);
    if (!slot) return invalid(c, 'Emplacement inconnu : statement:0, question:a, answer:a ou solution:0.');
    const lookup = lookupSlot(exercise, slot);
    if (!lookup.ok) return invalid(c, lookup.message);

    const body = await readBody(c);
    if (!body) return invalid(c, 'Corps de requête invalide.');

    const page = body.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
      return invalid(c, 'Page attendue (nombre entier, à partir de 1).');
    }
    const rect = asRect(body.rect);
    if (!rect) return invalid(c, 'Cadre attendu : [gauche, haut, droite, bas] en points.');

    const subject = catalog.subjects.find((item) => item.id === exercise.subject);
    if (!subject) return invalid(c, 'Matière inconnue pour cet exercice.');

    try {
      const pdfPath = pdf.pdfPath(subject.pdf);
      const metrics = await pdf.checkPage(pdfPath, page, subject.pages);
      const [x0, y0, x1, y1] = rect;
      if (x0 < 0 || y0 < 0 || x1 > metrics.widthPt + 0.5 || y1 > metrics.heightPt + 0.5) {
        return invalid(
          c,
          `Le cadre doit rester dans la page (${Math.round(metrics.widthPt)} × ${Math.round(metrics.heightPt)} pt).`,
        );
      }
      if (x1 - x0 < MIN_CROP_PT || y1 - y0 < MIN_CROP_PT) {
        return invalid(c, `Le cadre doit faire au moins ${MIN_CROP_PT} pt de large et de haut.`);
      }

      const previous = store.getCropSlot(exercise.id, slotRaw);
      const rendered = await pdf.renderCrop(pdfPath, page, rect, exercise.id, slotRaw);
      store.saveCropSlot({
        exerciseId: exercise.id,
        slot: slotRaw,
        page,
        x0: Math.round(x0 * 100) / 100,
        y0: Math.round(y0 * 100) / 100,
        x1: Math.round(x1 * 100) / 100,
        y1: Math.round(y1 * 100) / 100,
        src: rendered.src,
        w: rendered.w,
        h: rendered.h,
      });
      if (previous && previous.src !== rendered.src) pdf.removeCrop(previous.src);

      const merged = mergedExercise(catalog, store, exercise.id)!;
      const after = lookupSlot(merged, slot);
      return c.json({
        ok: true,
        exerciseId: exercise.id,
        slot: slotRaw,
        image: after.ok ? after.crop : null,
        manualSlots: merged.manualSlots,
        exercise: merged,
      });
    } catch (error) {
      return pdfFailure(c, error);
    }
  });

  app.delete('/api/exercises/:id/crops/:slot', (c) => {
    const catalog = getCatalog();
    const exercise = catalog.exercises.find((item) => item.id === c.req.param('id'));
    if (!exercise) return notFound(c, 'Exercice inconnu.');

    const slotRaw = c.req.param('slot');
    const slot = parseSlot(slotRaw);
    if (!slot) return invalid(c, 'Emplacement inconnu : statement:0, question:a, answer:a ou solution:0.');
    const lookup = lookupSlot(exercise, slot);
    if (!lookup.ok) return invalid(c, lookup.message);

    const previous = store.getCropSlot(exercise.id, slotRaw);
    store.deleteCropSlot(exercise.id, slotRaw);
    if (previous) pdf.removeCrop(previous.src);

    const merged = mergedExercise(catalog, store, exercise.id)!;
    const after = lookupSlot(merged, slot);
    const image: Crop | null = after.ok ? after.crop : null;
    return c.json({
      ok: true,
      exerciseId: exercise.id,
      slot: slotRaw,
      image,
      manualSlots: merged.manualSlots,
      exercise: merged,
    });
  });

  app.all('/api/*', (c) => notFound(c, 'Route inconnue.'));

  // Découpes du polycopié.
  app.use('/crops/*', async (c, next) => {
    if (c.req.path.includes('..')) return c.text('Requête invalide', 400);
    c.header('Cache-Control', 'public, max-age=86400');
    await next();
  });
  if (existsSync(dataDir)) {
    app.get('/crops/*', serveStatic({ root: dataDir }));
  }
  app.get('/crops/*', (c) => c.text('Découpe introuvable.', 404));

  // Pages du PDF (éditeur de recadrage) et découpes refaites à la main.
  app.use('/pdf-pages/*', async (c, next) => {
    if (c.req.path.includes('..')) return c.text('Requête invalide', 400);
    c.header('Cache-Control', 'public, max-age=86400');
    await next();
  });
  app.get(
    '/pdf-pages/*',
    serveStatic({
      root: appDataDir,
      rewriteRequestPath: (path) => path.replace(/^\/pdf-pages/, '/pages'),
    }),
  );
  app.get('/pdf-pages/*', (c) => c.text('Page introuvable.', 404));

  app.use('/crops-override/*', async (c, next) => {
    if (c.req.path.includes('..')) return c.text('Requête invalide', 400);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    await next();
  });
  app.get('/crops-override/*', serveStatic({ root: appDataDir }));
  app.get('/crops-override/*', (c) => c.text('Découpe introuvable.', 404));

  // Front compilé + repli SPA.
  const webDist = deps.webDist;
  if (webDist && existsSync(webDist)) {
    app.use('*', serveStatic({ root: webDist }));
    const indexFile = join(webDist, 'index.html');
    app.get('*', (c) => {
      if (!existsSync(indexFile)) return c.text('Interface non compilée : lance npm run build.', 503);
      c.header('Cache-Control', 'no-cache');
      return c.html(readFileSync(indexFile, 'utf8'));
    });
  } else {
    app.get('*', (c) =>
      c.text('Interface non compilée. Lance « npm run build » ou « npm run dev » (Vite sert le front).', 503),
    );
  }

  return app;
}

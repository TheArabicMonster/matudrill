import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { deriveStatus } from './status.js';
import type {
  AttemptInput,
  CropOverride,
  ResultValue,
  Session,
  SessionDetail,
  SessionItem,
  SessionItemInput,
  SessionMode,
  SessionSummary,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_id TEXT NOT NULL,
  part TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'mid', 'ko')),
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_latest ON attempts (exercise_id, part, id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('step', 'all')),
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS session_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  parts TEXT NOT NULL,
  position INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_items_session ON session_items (session_id, position);

CREATE TABLE IF NOT EXISTS verifications (
  exercise_id TEXT PRIMARY KEY,
  verified INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Découpes refaites à la main depuis le PDF, une ligne par emplacement
 * (`statement:0`, `question:a`, `answer:a`, `solution:0`).
 */
const CROP_SLOTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS crop_overrides (
  exercise_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  page INTEGER NOT NULL,
  x0 REAL NOT NULL,
  y0 REAL NOT NULL,
  x1 REAL NOT NULL,
  y1 REAL NOT NULL,
  src TEXT NOT NULL,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (exercise_id, slot)
);
`;

interface AttemptRow {
  exercise_id: string;
  part: string | null;
  result: ResultValue;
  created_at: string;
}

interface SessionRow {
  id: string;
  mode: SessionMode;
  created_at: string;
  finished_at: string | null;
}

interface SessionItemRow {
  exercise_id: string;
  parts: string;
  position: number;
  elapsed_ms: number;
}

interface VerificationRow {
  exercise_id: string;
  verified: number;
}

interface CropOverrideRow {
  exercise_id: string;
  slot: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  src: string;
  w: number;
  h: number;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    mode: row.mode,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toParts(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((part): part is string => typeof part === 'string');
  } catch {
    return [];
  }
}

function toSessionItem(row: SessionItemRow): SessionItem {
  return {
    exerciseId: row.exercise_id,
    parts: toParts(row.parts),
    position: row.position,
    elapsedMs: row.elapsed_ms,
  };
}

function totalElapsed(items: SessionItem[]): number {
  return items.reduce((total, item) => total + item.elapsedMs, 0);
}

function toCropOverride(row: CropOverrideRow): CropOverride {
  return {
    exerciseId: row.exercise_id,
    slot: row.slot,
    page: row.page,
    x0: row.x0,
    y0: row.y0,
    x1: row.x1,
    y1: row.y1,
    src: row.src,
    w: row.w,
    h: row.h,
    updatedAt: row.updated_at,
  };
}

export class Store {
  private readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrateCropSlots();
    this.migrateSessionItemTime();
  }

  /**
   * L'ancien tableau `crop_overrides` ne stockait qu'un réglage haut/bas
   * jamais appliqué (l'API répondait 202). On le remplace par les
   * emplacements recadrés à la main.
   */
  private migrateCropSlots(): void {
    const columns = this.db.prepare('PRAGMA table_info(crop_overrides)').all() as { name: string }[];
    if (columns.length > 0 && !columns.some((column) => column.name === 'slot')) {
      this.db.exec('DROP TABLE crop_overrides');
    }
    this.db.exec(CROP_SLOTS_SCHEMA);
  }

  /**
   * Chronomètre par exercice (v1.2) : la base de production a déjà des
   * `session_items` sans `elapsed_ms`, et `CREATE TABLE IF NOT EXISTS` ne la
   * complète pas. Idempotent : la colonne n'est ajoutée que si elle manque.
   */
  private migrateSessionItemTime(): void {
    const columns = this.db.prepare('PRAGMA table_info(session_items)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'elapsed_ms')) {
      this.db.exec('ALTER TABLE session_items ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0');
    }
  }

  close(): void {
    this.db.close();
  }

  addAttempt(input: AttemptInput): void {
    this.db
      .prepare(
        `INSERT INTO attempts (exercise_id, part, result, session_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.exerciseId, input.part ?? null, input.result, input.sessionId ?? null, nowIso());
  }

  /** Dernière auto-évaluation de chaque sous-question, tous exercices confondus. */
  getLatestResults(): { exerciseId: string; part: string | null; result: ResultValue; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT exercise_id, part, result, created_at FROM (
           SELECT exercise_id, part, result, created_at,
                  ROW_NUMBER() OVER (PARTITION BY exercise_id, IFNULL(part, '') ORDER BY id DESC) AS rn
           FROM attempts
         ) WHERE rn = 1`,
      )
      .all() as AttemptRow[];
    return rows.map((row) => ({
      exerciseId: row.exercise_id,
      part: row.part,
      result: row.result,
      createdAt: row.created_at,
    }));
  }

  getVerifiedIds(): Set<string> {
    const rows = this.db.prepare('SELECT exercise_id FROM verifications WHERE verified = 1').all() as VerificationRow[];
    return new Set(rows.map((row) => row.exercise_id));
  }

  setVerified(exerciseId: string, verified: boolean): void {
    this.db
      .prepare(
        `INSERT INTO verifications (exercise_id, verified, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (exercise_id) DO UPDATE SET verified = excluded.verified, updated_at = excluded.updated_at`,
      )
      .run(exerciseId, verified ? 1 : 0, nowIso());
  }

  createSession(mode: SessionMode, items: SessionItemInput[]): Session {
    const id = `ses_${randomUUID()}`;
    const createdAt = nowIso();
    const insertSession = this.db.prepare('INSERT INTO sessions (id, mode, created_at) VALUES (?, ?, ?)');
    const insertItem = this.db.prepare(
      'INSERT INTO session_items (session_id, exercise_id, parts, position) VALUES (?, ?, ?, ?)',
    );
    const run = this.db.transaction(() => {
      insertSession.run(id, mode, createdAt);
      items.forEach((item, index) => {
        insertItem.run(id, item.exerciseId, JSON.stringify(item.parts), index);
      });
    });
    run();
    return { id, mode, createdAt, finishedAt: null };
  }

  getSession(id: string): SessionDetail | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) return null;
    const itemRows = this.db
      .prepare(
        'SELECT exercise_id, parts, position, elapsed_ms FROM session_items WHERE session_id = ? ORDER BY position ASC, id ASC',
      )
      .all(id) as SessionItemRow[];
    const items = itemRows.map(toSessionItem);
    return {
      ...toSession(row),
      items,
      totalElapsedMs: totalElapsed(items),
    };
  }

  /** Un exercice d'une session (le premier si l'exercice y apparaît deux fois). */
  getSessionItem(sessionId: string, exerciseId: string): SessionItem | null {
    const row = this.db
      .prepare(
        `SELECT exercise_id, parts, position, elapsed_ms FROM session_items
         WHERE session_id = ? AND exercise_id = ?
         ORDER BY position ASC, id ASC LIMIT 1`,
      )
      .get(sessionId, exerciseId) as SessionItemRow | undefined;
    return row ? toSessionItem(row) : null;
  }

  /** Temps cumulé d'un exercice dans une session (écrase la valeur précédente). */
  setSessionItemElapsed(sessionId: string, exerciseId: string, elapsedMs: number): void {
    this.db
      .prepare(
        `UPDATE session_items SET elapsed_ms = ?
         WHERE id = (
           SELECT id FROM session_items
           WHERE session_id = ? AND exercise_id = ?
           ORDER BY position ASC, id ASC LIMIT 1
         )`,
      )
      .run(elapsedMs, sessionId, exerciseId);
  }

  getSessionTotalElapsed(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(elapsed_ms), 0) AS total FROM session_items WHERE session_id = ?')
      .get(sessionId) as { total: number };
    return row.total;
  }

  /**
   * Temps du dernier passage terminé de chaque exercice : la dernière session
   * clôturée qui le contient et où un temps a été enregistré.
   */
  getLastElapsed(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT exercise_id, elapsed_ms FROM (
           SELECT si.exercise_id, si.elapsed_ms,
                  ROW_NUMBER() OVER (
                    PARTITION BY si.exercise_id ORDER BY sessions.finished_at DESC, si.id DESC
                  ) AS rn
           FROM session_items si
           JOIN sessions ON sessions.id = si.session_id
           WHERE sessions.finished_at IS NOT NULL AND si.elapsed_ms > 0
         ) WHERE rn = 1`,
      )
      .all() as { exercise_id: string; elapsed_ms: number }[];
    return new Map(rows.map((row) => [row.exercise_id, row.elapsed_ms]));
  }

  finishSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) return null;
    if (!row.finished_at) {
      this.db.prepare('UPDATE sessions SET finished_at = ? WHERE id = ?').run(nowIso(), id);
    }
    const updated = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow;
    return toSession(updated);
  }

  getSessionSummary(id: string): SessionSummary | null {
    const session = this.getSession(id);
    if (!session) return null;

    const attempts = this.db
      .prepare(
        `SELECT exercise_id, part, result FROM (
           SELECT exercise_id, part, result,
                  ROW_NUMBER() OVER (PARTITION BY exercise_id, IFNULL(part, '') ORDER BY id DESC) AS rn
           FROM attempts WHERE session_id = ?
         ) WHERE rn = 1`,
      )
      .all(id) as AttemptRow[];

    const results = new Map<string, ResultValue>();
    for (const attempt of attempts) {
      results.set(`${attempt.exercise_id}::${attempt.part ?? ''}`, attempt.result);
    }

    const exercises = session.items.map((item) => {
      const labels: (string | null)[] = item.parts.length > 0 ? item.parts : [null];
      const parts = labels.map((label) => ({
        label,
        result: results.get(`${item.exerciseId}::${label ?? ''}`) ?? null,
      }));
      const evaluated = parts.map((part) => part.result).filter((result): result is ResultValue => result !== null);
      return {
        exerciseId: item.exerciseId,
        result: deriveStatus(evaluated),
        parts,
        elapsedMs: item.elapsedMs,
      };
    });

    const errors: { exerciseId: string; part: string | null }[] = [];
    for (const exercise of exercises) {
      for (const part of exercise.parts) {
        if (part.result === 'ko') errors.push({ exerciseId: exercise.exerciseId, part: part.label });
      }
    }

    return {
      id: session.id,
      mode: session.mode,
      createdAt: session.createdAt,
      finishedAt: session.finishedAt,
      exercises,
      errors,
      totalElapsedMs: session.totalElapsedMs,
    };
  }

  saveCropSlot(input: {
    exerciseId: string;
    slot: string;
    page: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    src: string;
    w: number;
    h: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO crop_overrides (exercise_id, slot, page, x0, y0, x1, y1, src, w, h, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (exercise_id, slot) DO UPDATE SET
           page = excluded.page, x0 = excluded.x0, y0 = excluded.y0, x1 = excluded.x1, y1 = excluded.y1,
           src = excluded.src, w = excluded.w, h = excluded.h, updated_at = excluded.updated_at`,
      )
      .run(
        input.exerciseId,
        input.slot,
        input.page,
        input.x0,
        input.y0,
        input.x1,
        input.y1,
        input.src,
        input.w,
        input.h,
        nowIso(),
      );
  }

  getCropSlot(exerciseId: string, slot: string): CropOverride | null {
    const row = this.db
      .prepare('SELECT * FROM crop_overrides WHERE exercise_id = ? AND slot = ?')
      .get(exerciseId, slot) as CropOverrideRow | undefined;
    return row ? toCropOverride(row) : null;
  }

  getCropSlots(exerciseId: string): CropOverride[] {
    const rows = this.db
      .prepare('SELECT * FROM crop_overrides WHERE exercise_id = ? ORDER BY slot ASC')
      .all(exerciseId) as CropOverrideRow[];
    return rows.map(toCropOverride);
  }

  /** Tous les emplacements recadrés, pour fusionner le catalogue en une passe. */
  getAllCropSlots(): CropOverride[] {
    const rows = this.db.prepare('SELECT * FROM crop_overrides ORDER BY exercise_id ASC, slot ASC').all() as
      CropOverrideRow[];
    return rows.map(toCropOverride);
  }

  deleteCropSlot(exerciseId: string, slot: string): void {
    this.db.prepare('DELETE FROM crop_overrides WHERE exercise_id = ? AND slot = ?').run(exerciseId, slot);
  }
}

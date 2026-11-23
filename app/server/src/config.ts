import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `app/server`, que le fichier soit exécuté depuis `src/` (tsx) ou `dist/` (node). */
export const SERVER_ROOT = resolve(HERE, '..');

export interface RuntimePaths {
  dataDir: string;
  /** Base SQLite, overrides de découpe et pages rendues. */
  appDataDir: string;
  dbPath: string;
  pdfsDir: string;
  cropsOverrideDir: string;
  pagesDir: string;
  webDist: string;
}

/**
 * Un chemin relatif est cherché d'abord depuis le dossier courant, puis depuis
 * `app/server`, pour que `npm run dev`, `npm start` et les tests tombent sur le
 * même dossier. `probe` permet de préférer un candidat qui contient vraiment
 * les fichiers attendus.
 */
function resolveDir(raw: string, probe?: string): string {
  const candidates = isAbsolute(raw)
    ? [raw]
    : [resolve(process.cwd(), raw), resolve(SERVER_ROOT, raw)];
  if (!probe) return candidates[0]!;
  return candidates.find((candidate) => existsSync(join(candidate, probe))) ?? candidates[0]!;
}

/** Comme `resolveDir`, mais préfère le candidat qui existe vraiment (dossier). */
function resolveExistingDir(raw: string): string {
  const candidates = isAbsolute(raw)
    ? [raw]
    : [resolve(process.cwd(), raw), resolve(SERVER_ROOT, raw)];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const dataDir = resolveDir(env.DATA_DIR?.trim() || '../../data', 'catalog.json');

  // APP_DATA_DIR regroupe tout ce que le site écrit (base, overrides, pages).
  // Par défaut il reste à côté du catalogue, comme avant.
  const rawAppDataDir = env.APP_DATA_DIR?.trim();
  const appDataDir = rawAppDataDir ? resolveDir(rawAppDataDir) : resolve(dataDir, '..', 'app-data');

  const rawDbPath = env.DB_PATH?.trim();
  const dbPath = rawDbPath
    ? isAbsolute(rawDbPath)
      ? rawDbPath
      : resolve(SERVER_ROOT, rawDbPath)
    : join(appDataDir, 'matudrill.db');

  const pdfsDir = resolveExistingDir(env.PDFS_DIR?.trim() || '../../pdfs');

  const rawWebDist = env.WEB_DIST?.trim();
  const webDist = rawWebDist
    ? isAbsolute(rawWebDist)
      ? rawWebDist
      : resolve(SERVER_ROOT, rawWebDist)
    : resolve(SERVER_ROOT, '..', 'web', 'dist');

  return {
    dataDir,
    appDataDir,
    dbPath,
    pdfsDir,
    cropsOverrideDir: join(appDataDir, 'crops-override'),
    pagesDir: join(appDataDir, 'pages'),
    webDist,
  };
}

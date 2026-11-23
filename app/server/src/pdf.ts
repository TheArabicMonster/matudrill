import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Page entière de l'éditeur de recadrage. 200 dpi : le zoom de l'éditeur
 * (jusqu'à 300 %) reste net. Le nom du fichier porte le dpi pour que le cache
 * ne serve jamais une page rendue à une autre résolution.
 */
export const PAGE_DPI = 200;
/** Même résolution que les découpes du pipeline. */
const CROP_DPI = 150;
const PT_PER_INCH = 72;

const A4_WIDTH_PT = 595;
const A4_HEIGHT_PT = 842;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Erreur destinée au client : `status` 400 pour une entrée invalide, 500 pour un rendu raté. */
export class PdfError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'PdfError';
    this.status = status;
  }
}

export interface PdfMetrics {
  pages: number;
  widthPt: number;
  heightPt: number;
}

export interface RenderedCrop {
  src: string;
  w: number;
  h: number;
}

export interface PdfServiceOptions {
  pdfsDir: string;
  pagesDir: string;
  cropsOverrideDir: string;
}

function pxFromPt(value: number, dpi: number): number {
  return Math.round((value * dpi) / PT_PER_INCH);
}

/** Largeur et hauteur d'un PNG, lues dans l'en-tête IHDR. */
export function readPngSize(file: string): { w: number; h: number } {
  const header = readFileSync(file).subarray(0, 24);
  if (header.length < 24 || header.toString('latin1', 1, 4) !== 'PNG') {
    throw new PdfError('Le rendu du PDF n’a pas produit une image valide.');
  }
  return { w: header.readUInt32BE(16), h: header.readUInt32BE(20) };
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Rendu des pages et des découpes avec poppler (`pdfinfo`, `pdftoppm`),
 * toujours via `execFile` : aucun passage par un shell.
 */
export class PdfService {
  private readonly metricsCache = new Map<string, PdfMetrics>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly options: PdfServiceOptions) {}

  /** Chemin du PDF d'une matière, confiné dans `PDFS_DIR`. */
  pdfPath(pdfFile: string): string {
    if (!SAFE_ID.test(pdfFile)) throw new PdfError('Nom de fichier PDF invalide.', 400);
    const path = join(this.options.pdfsDir, basename(pdfFile));
    if (!existsSync(path)) throw new PdfError(`Le PDF ${basename(pdfFile)} est introuvable.`);
    return path;
  }

  /** Nombre de pages du PDF, mis en cache par fichier. */
  async pageCount(pdfPath: string): Promise<number> {
    const key = `${pdfPath}::count`;
    const cached = this.metricsCache.get(key);
    if (cached) return cached.pages;

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('pdfinfo', [pdfPath], { timeout: 20_000, maxBuffer: 1 << 20 }));
    } catch {
      throw new PdfError('Impossible de lire le PDF (pdfinfo).', 500);
    }
    const pages = Number(/^Pages:\s+(\d+)$/m.exec(stdout)?.[1] ?? 0);
    const info: PdfMetrics = { pages: Number.isFinite(pages) ? pages : 0, widthPt: A4_WIDTH_PT, heightPt: A4_HEIGHT_PT };
    this.metricsCache.set(key, info);
    return info.pages;
  }

  /** Nombre de pages et format de la page demandée, mis en cache par sujet. */
  async pageMetrics(pdfPath: string, page: number): Promise<PdfMetrics> {
    const key = `${pdfPath}::${page}`;
    const cached = this.metricsCache.get(key);
    if (cached) return cached;

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('pdfinfo', ['-f', String(page), '-l', String(page), pdfPath], {
        timeout: 20_000,
        maxBuffer: 1 << 20,
      }));
    } catch {
      throw new PdfError('Impossible de lire le PDF (pdfinfo).', 500);
    }

    const pages = Number(/^Pages:\s+(\d+)$/m.exec(stdout)?.[1] ?? 0);
    const pageSize =
      /^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout) ??
      /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(stdout);

    const info: PdfMetrics = {
      pages: Number.isFinite(pages) ? pages : 0,
      widthPt: pageSize ? Number(pageSize[1]) : A4_WIDTH_PT,
      heightPt: pageSize ? Number(pageSize[2]) : A4_HEIGHT_PT,
    };
    this.metricsCache.set(key, info);
    return info;
  }

  /**
   * Vérifie la page demandée (bornes du PDF et du catalogue) et renvoie son
   * format. Lève une PdfError 400 hors bornes.
   */
  async checkPage(pdfPath: string, page: number, catalogPages: number): Promise<PdfMetrics> {
    const pages = await this.pageCount(pdfPath);
    const max = Math.min(...[pages, catalogPages].filter((count) => count > 0));
    if (!Number.isInteger(page) || page < 1 || (max > 0 && page > max)) {
      throw new PdfError(
        max > 0 ? `Cette page n’existe pas : le PDF va de 1 à ${max}.` : 'Numéro de page invalide.',
        400,
      );
    }
    return this.pageMetrics(pdfPath, page);
  }

  /** Page entière à `PAGE_DPI`, mise en cache dans `APP_DATA_DIR/pages`. */
  async pageImage(subjectId: string, pdfPath: string, page: number): Promise<string> {
    const name = `${sanitize(subjectId)}-${page}-${PAGE_DPI}dpi.png`;
    const target = join(this.options.pagesDir, name);
    const existing = this.pending.get(target);
    if (existing) return existing;
    if (existsSync(target)) return name;

    const job = this.render(pdfPath, ['-r', String(PAGE_DPI)], page, target, name).finally(() => {
      this.pending.delete(target);
    });
    this.pending.set(target, job);
    return job;
  }

  /**
   * Découpe une page à 150 dpi : `rect` en points, coordonnées px = pt × 150/72.
   * Le nom du fichier est unique pour qu'aucun cache ne serve une ancienne image.
   */
  async renderCrop(
    pdfPath: string,
    page: number,
    rect: [number, number, number, number],
    exerciseId: string,
    slot: string,
  ): Promise<RenderedCrop> {
    const [x0, y0, x1, y1] = rect;
    const left = pxFromPt(x0, CROP_DPI);
    const top = pxFromPt(y0, CROP_DPI);
    const width = Math.max(pxFromPt(x1, CROP_DPI) - left, 1);
    const height = Math.max(pxFromPt(y1, CROP_DPI) - top, 1);

    const name = `${sanitize(exerciseId)}__${sanitize(slot)}__${Date.now()}.png`;
    const target = join(this.options.cropsOverrideDir, name);
    await this.render(
      pdfPath,
      [
        '-r',
        String(CROP_DPI),
        '-x',
        String(left),
        '-y',
        String(top),
        '-W',
        String(width),
        '-H',
        String(height),
      ],
      page,
      target,
      name,
    );

    const size = readPngSize(target);
    return { src: `crops-override/${name}`, w: size.w, h: size.h };
  }

  /** Efface une découpe remplacée ou annulée (nom vérifié, jamais hors du dossier). */
  removeCrop(src: string): void {
    const name = basename(src);
    if (!SAFE_ID.test(name)) return;
    try {
      rmSync(join(this.options.cropsOverrideDir, name), { force: true });
    } catch {
      /* le fichier a déjà disparu */
    }
  }

  private async render(
    pdfPath: string,
    extraArgs: string[],
    page: number,
    target: string,
    name: string,
  ): Promise<string> {
    mkdirSync(this.options.pagesDir, { recursive: true });
    mkdirSync(this.options.cropsOverrideDir, { recursive: true });

    const prefix = `${target}.${process.pid}.tmp`;
    try {
      await execFileAsync(
        'pdftoppm',
        ['-png', ...extraArgs, '-f', String(page), '-l', String(page), '-singlefile', pdfPath, prefix],
        { timeout: 60_000, maxBuffer: 1 << 20 },
      );
      renameSync(`${prefix}.png`, target);
    } catch {
      rmSync(`${prefix}.png`, { force: true });
      throw new PdfError('Le rendu de la page a échoué (pdftoppm). Réessaie.', 500);
    }
    return name;
  }
}

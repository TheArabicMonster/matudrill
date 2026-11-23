import type { Rect } from '../types';

/** Points PostScript par pouce, comme le rendu du PDF côté serveur. */
export const PT_PER_INCH = 72;

/** Résolution CSS de référence : 100 % = taille réelle à l'écran. */
export const SCREEN_DPI = 96;

/** Pixels CSS par point à 100 % de zoom. */
export const SCREEN_PX_PER_PT = SCREEN_DPI / PT_PER_INCH;

/**
 * Résolution des pages servies avant le passage à 200 dpi : un serveur plus
 * ancien ne renvoie pas le dpi, ses images restent utilisables telles quelles.
 */
export const LEGACY_PAGE_DPI = 110;

export interface PageMetrics {
  widthPt: number;
  heightPt: number;
}

export interface PreviewGeometry {
  /** Image entière mise à l'échelle, en px CSS (tel quel dans `background-size`). */
  backgroundSize: string;
  /** Décalage négatif du cadre dans l'image, en px CSS (`background-position`). */
  backgroundPosition: string;
  /** Taille du cadre affiché, en px CSS. */
  width: number;
  height: number;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Pixels de l'image de page pour un nombre de points, à `dpi`. */
export function pxFromPt(value: number, dpi: number): number {
  return (value * dpi) / PT_PER_INCH;
}

/**
 * Géométrie de l'aperçu « rendu » : l'image de page (rendue à `dpi`, donc
 * `px = pt × dpi / 72`) est agrandie du facteur `s` tel que la largeur du
 * cadre [x0, y0, x1, y1] remplisse exactement `panelWidth` px. Le cadre est
 * ensuite calé par un décalage négatif, sans jamais redimensionner l'image
 * autrement que par `s` (ratio de la page conservé).
 */
export function previewGeometry(
  rect: Rect,
  page: PageMetrics,
  dpi: number,
  panelWidth: number,
): PreviewGeometry {
  const [x0, y0, x1, y1] = rect;
  const cropWidthPx = Math.max(pxFromPt(x1 - x0, dpi), 1e-6);
  const factor = Math.max(panelWidth, 0) / cropWidthPx;
  return {
    backgroundSize: `${round3(pxFromPt(page.widthPt, dpi) * factor)}px ${round3(pxFromPt(page.heightPt, dpi) * factor)}px`,
    backgroundPosition: `${round3(-pxFromPt(x0, dpi) * factor)}px ${round3(-pxFromPt(y0, dpi) * factor)}px`,
    width: round3(cropWidthPx * factor),
    height: round3(pxFromPt(y1 - y0, dpi) * factor),
  };
}

/**
 * Échelle d'affichage de la page : `width` remplit la largeur disponible,
 * `page` fait tenir toute la page, `manual` garde le pourcentage choisi.
 * 100 % = page à sa taille réelle (96 dpi CSS).
 */
export function pageScale(
  mode: 'width' | 'page' | 'manual',
  manual: number,
  page: PageMetrics,
  area: { width: number; height: number },
): number {
  const baseWidth = page.widthPt * SCREEN_PX_PER_PT;
  const baseHeight = page.heightPt * SCREEN_PX_PER_PT;
  if (mode === 'manual') return manual;
  if (area.width <= 0) return 0;
  const fitWidth = area.width / baseWidth;
  if (mode === 'width') return fitWidth;
  if (area.height <= 0) return fitWidth;
  return Math.min(fitWidth, area.height / baseHeight);
}

/** Paliers des boutons − / +. */
export const ZOOM_STEPS = [0.75, 1, 1.5, 2, 3] as const;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;

/**
 * Palier suivant (direction 1) ou précédent (-1). Aux bornes de la grille la
 * valeur ne bouge pas : « − » ne doit jamais agrandir ni « + » réduire.
 */
export function nextZoomStep(current: number, direction: 1 | -1): number {
  const tolerance = 0.005;
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > current + tolerance) ?? current;
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < current - tolerance) ?? current;
}

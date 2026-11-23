import { describe, expect, it } from 'vitest';

import { nextZoomStep, pageScale, previewGeometry, pxFromPt } from './preview';

/** Cadre de la sous-question a) de l'exercice Algèbre 3.4, page 78. */
const RECT: [number, number, number, number] = [74, 421, 318, 454];
const A4 = { widthPt: 595.276, heightPt: 841.89 };

/** Deux valeurs « 12.5px » → [12.5, …]. */
function px(value: string): number[] {
  return value
    .split(' ')
    .map((part) => Number(part.replace('px', '')));
}

describe('previewGeometry', () => {
  it('montre exactement le cadre, à l’échelle du panneau (page à 110 dpi)', () => {
    const panelWidth = 320;
    const dpi = 110;
    const cropWidthPx = (318 - 74) * (110 / 72);
    const s = panelWidth / cropWidthPx;

    const geometry = previewGeometry(RECT, A4, dpi, panelWidth);

    const position = px(geometry.backgroundPosition);
    expect(position[0]).toBeCloseTo(-74 * (110 / 72) * s, 3);
    expect(position[1]).toBeCloseTo(-421 * (110 / 72) * s, 3);

    const size = px(geometry.backgroundSize);
    expect(size[0]).toBeCloseTo(595.276 * (110 / 72) * s, 3);
    expect(size[1]).toBeCloseTo(841.89 * (110 / 72) * s, 3);

    // Le cadre occupe la largeur du panneau, ratio conservé.
    expect(geometry.width).toBeCloseTo(panelWidth, 3);
    expect(geometry.height).toBeCloseTo((454 - 421) * (110 / 72) * s, 3);
    expect(geometry.width / geometry.height).toBeCloseTo((318 - 74) / (454 - 421), 3);
  });

  it('donne le même cadrage visible quel que soit le dpi de l’image servie', () => {
    const at110 = previewGeometry(RECT, A4, 110, 300);
    const at200 = previewGeometry(RECT, A4, 200, 300);

    // Une image plus fine ne change pas la zone montrée : seul le nombre de
    // pixels disponibles pour l'agrandir change (donc la netteté).
    expect(px(at200.backgroundSize)).toEqual(px(at110.backgroundSize));
    expect(px(at200.backgroundPosition)).toEqual(px(at110.backgroundPosition));
    expect(at200.width).toBeCloseTo(at110.width, 6);
    expect(at200.height).toBeCloseTo(at110.height, 6);

    // L'image à 200 dpi est deux fois plus fine pour la même zone : la taille
    // du cadre vaut 300 px, donc 300 × (200/200 …) → vérifié par l'échelle.
    const cropWidthPxAt200 = (318 - 74) * (200 / 72);
    expect(at200.backgroundSize).toBe(
      `${Math.round(((595.276 * 200) / 72) * (300 / cropWidthPxAt200) * 1000) / 1000}px ${Math.round(((841.89 * 200) / 72) * (300 / cropWidthPxAt200) * 1000) / 1000}px`,
    );
  });

  it('accepte un panneau de largeur nulle sans NaN', () => {
    const geometry = previewGeometry(RECT, A4, 200, 0);
    expect(geometry.width).toBe(0);
    expect(geometry.height).toBe(0);
    expect(geometry.backgroundSize).toBe('0px 0px');
    expect(geometry.backgroundPosition).toBe('0px 0px');
  });
});

describe('pxFromPt', () => {
  it('convertit les points en pixels de l’image', () => {
    expect(pxFromPt(595.276, 200)).toBeCloseTo(1653.54, 2);
  });
});

describe('pageScale', () => {
  const area = { width: 1036, height: 700 };

  it('remplit la largeur par défaut', () => {
    expect(pageScale('width', 1, A4, area)).toBeCloseTo(1036 / ((595.276 * 96) / 72), 6);
  });

  it('fait tenir la page entière', () => {
    const scale = pageScale('page', 1, A4, area);
    expect((595.276 * 96 * scale) / 72).toBeLessThanOrEqual(area.width + 0.001);
    expect((841.89 * 96 * scale) / 72).toBeLessThanOrEqual(area.height + 0.001);
    // La hauteur est la contrainte ici.
    expect((841.89 * 96 * scale) / 72).toBeCloseTo(area.height, 6);
  });

  it('garde le pourcentage manuel et attend une mesure du panneau', () => {
    expect(pageScale('manual', 1.5, A4, area)).toBe(1.5);
    expect(pageScale('width', 1, A4, { width: 0, height: 0 })).toBe(0);
  });
});

describe('nextZoomStep', () => {
  it('parcourt les paliers 75, 100, 150, 200, 300 %', () => {
    expect(nextZoomStep(0.6, 1)).toBe(0.75);
    expect(nextZoomStep(0.75, 1)).toBe(1);
    expect(nextZoomStep(1, 1)).toBe(1.5);
    expect(nextZoomStep(1.5, 1)).toBe(2);
    expect(nextZoomStep(2, 1)).toBe(3);
    expect(nextZoomStep(3, 1)).toBe(3);
    expect(nextZoomStep(3, -1)).toBe(2);
    expect(nextZoomStep(2, -1)).toBe(1.5);
    expect(nextZoomStep(1.2, -1)).toBe(1);
    expect(nextZoomStep(0.8, -1)).toBe(0.75);
    expect(nextZoomStep(0.75, -1)).toBe(0.75);
    // Hors grille (molette) : on s'arrête, on ne repart jamais à l'envers.
    expect(nextZoomStep(4, 1)).toBe(4);
    expect(nextZoomStep(0.5, -1)).toBe(0.5);
  });
});

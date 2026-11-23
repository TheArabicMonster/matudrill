"""Rendu PNG des découpes et planches de contrôle.

Une découpe est rendue à 150 dpi (1 pt = 150/72 px, fond blanc). Les zones
calculées par `exercises.py` incluent déjà leur marge de 4 pt (réduite quand un
voisin est proche) : le rendu se fait donc sans marge supplémentaire.

Les rectangles de découpe peuvent se chevaucher de quelques points sur les
pages à deux colonnes. Après le rendu, on peint donc en blanc, dans le pixmap,
toutes les bbox de spans et de dessins qui appartiennent à une autre région
(voir `regions.py`). Les glyphes partagés à la frontière restent à la région
dont la ligne les revendique.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import pymupdf

from pdf_layout import Document, MARGIN, WHITEN_PAD

DPI = 150
PT_TO_PX = DPI / 72.0
# Demi-point de garde autour des rectangles blanchis (anticrénelage des bords).
PAD = WHITEN_PAD
# Seuil de « pixel sombre » (comme render.ink_pixels).
DARK_THRESHOLD = 200


def clamp_rect(page_rect: pymupdf.Rect, rect: Sequence[float],
               margin: float = MARGIN) -> pymupdf.Rect:
    clip = pymupdf.Rect(rect[0] - margin, rect[1] - margin,
                        rect[2] + margin, rect[3] + margin)
    return clip & page_rect


@dataclass
class WhitenDiff:
    """Contrôle indépendant du blanchiment, mesuré sur les pixels.

    - `painted` : rectangles effectivement peints ;
    - `removed` : pixels sombres effectivement effacés (sombres avant, blancs
      après) ;
    - `inside` : parmi eux, pixels qui tombent dans une *boîte de ligne propre*
      de la zone : c'est une erreur (on a effacé un exposant, un indice ou un
      morceau de formule de la région) ;
    - `outside` : parmi eux, pixels qui ne tombent dans **aucun** titre étranger
      (`allowed`) : en mode ``headings``, la seule différence autorisée entre le
      rendu brut et le rendu final est l'encre d'un titre étranger, donc ce
      compteur doit valoir 0. Il n'est mesuré que si `allowed` est fourni.
    """

    painted: int = 0
    removed: int = 0
    inside: int = 0
    outside: int = 0
    strict: bool = False

    @property
    def error(self) -> bool:
        return self.inside > 0 or (self.strict and self.outside > 0)


def _ceil_px(value: float) -> int:
    """Arrondi vers le haut, avec un pixel de garde (anti-anticrénelage)."""
    return int(value) + 1


def whiten_pixmap(pixmap: pymupdf.Pixmap, clip: pymupdf.Rect,
                  boxes: Iterable[Sequence[float]],
                  dpi: int = DPI,
                  watch: Iterable[Sequence[float]] = (),
                  allowed: Iterable[Sequence[float]] = (),
                  strict: bool = False,
                  threshold: int = DARK_THRESHOLD) -> WhitenDiff:
    """Peint en blanc des rectangles (coordonnées PDF) dans un pixmap.

    Les coordonnées sont converties de points en pixels puis arrondies vers
    l'extérieur pour ne pas laisser de liseré d'anticrénelage. Avant de peindre
    chaque rectangle, on compte les pixels sombres qu'il efface et, parmi eux,
    ceux qui tombent dans une boîte `watch` (boîtes de ligne propres de la
    zone) : ce dernier compteur est le contrôle indépendant du blanchiment.

    `allowed` est l'enveloppe des titres étrangers : en mode ``headings``
    (`strict=True`), un pixel effacé hors de ces enveloppes est une erreur.
    """
    scale = dpi / 72.0
    samples = pixmap.samples_mv
    stride = pixmap.stride
    channels = pixmap.n
    width, height = pixmap.width, pixmap.height
    diff = WhitenDiff(strict=strict)
    watch_px = [tuple(float(v) for v in box) for box in watch]
    allowed_px = [tuple(float(v) for v in box) for box in allowed]
    for box in boxes:
        # demi-point de garde : l'anticrénelage du bord reste visible sinon
        x0 = int((box[0] - PAD - clip.x0) * scale)
        x1 = _ceil_px((box[2] + PAD - clip.x0) * scale)
        y0 = int((box[1] - PAD - clip.y0) * scale)
        y1 = _ceil_px((box[3] + PAD - clip.y0) * scale)
        x0 = max(0, min(width, x0))
        x1 = max(0, min(width, x1))
        y0 = max(0, min(height, y0))
        y1 = max(0, min(height, y1))
        if x1 <= x0 or y1 <= y0:
            continue
        for y in range(y0, y1):
            start = y * stride + x0 * channels
            end = y * stride + x1 * channels
            row = samples[start:end]
            for offset in range(0, len(row), channels):
                if min(row[offset:offset + 3]) < threshold:
                    diff.removed += 1
                    # centre du pixel en coordonnées PDF
                    px = clip.x0 + (x0 + offset // channels + 0.5) / scale
                    py = clip.y0 + (y + 0.5) / scale
                    if watch_px and any(a <= px <= c and b <= py <= d
                                        for a, b, c, d in watch_px):
                        diff.inside += 1
                    if allowed_px and not any(a <= px <= c and b <= py <= d
                                              for a, b, c, d in allowed_px):
                        diff.outside += 1
            samples[start:end] = b"\xff" * len(row)
        diff.painted += 1
    return diff


def crop_clip(doc: Document, zone, margin: float = MARGIN) -> pymupdf.Rect:
    """Rectangle effectivement rendu pour une zone (et origine des pixels)."""
    page = doc.doc[zone.page - 1]
    return clamp_rect(page.rect, zone.rect, margin)


def crop_rect(doc: Document, zone,
              margin: float = MARGIN) -> list[float]:
    """Rectangle exact rendu pour une zone, en points PDF (dixième).

    C'est le `clip` de `crop_clip`, donc celui passé à `page.get_pixmap()` :
    marges comprises, ramené dans la page. Arrondi au dixième de point, il est
    publié dans le catalogue (`rect`) pour que l'app puisse retrouver et
    re-rendre la découpe depuis le PDF.
    """
    clip = crop_clip(doc, zone, margin)
    return [round(clip.x0, 1), round(clip.y0, 1),
            round(clip.x1, 1), round(clip.y1, 1)]


def render_crop(doc: Document, zone, out_path: Path, dpi: int = DPI,
                margin: float = MARGIN,
                whiten: Iterable[Sequence[float]] = (),
                watch: Iterable[Sequence[float]] = (),
                allowed: Iterable[Sequence[float]] = (),
                strict: bool = False
                ) -> tuple[int, int, WhitenDiff]:
    """Rend une zone en PNG ; renvoie (largeur, hauteur, contrôle du blanc).

    L'image est d'abord rendue *sans* blanchiment, puis une copie est blanchie.
    Le pixmap non blanchi sert au contrôle indépendant : on y compte les pixels
    sombres effacés et ceux qui tombent dans une boîte de ligne propre
    (`watch`) — ce dernier compteur doit toujours valoir 0 — ainsi que ceux
    effacés hors des titres étrangers (`allowed`, mode ``headings``).
    """
    page = doc.doc[zone.page - 1]
    clip = crop_clip(doc, zone, margin)
    if clip.width <= 1 or clip.height <= 1:
        raise ValueError(f"zone dégénérée : {zone.rect}")
    pixmap = page.get_pixmap(dpi=dpi, clip=clip, alpha=False)
    diff = WhitenDiff()
    if whiten:
        diff = whiten_pixmap(pixmap, clip, whiten, dpi, watch, allowed, strict)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pixmap.save(str(out_path))
    return pixmap.width, pixmap.height, diff


def render_whiten_diff(doc: Document, zone, out_path: Path, dpi: int = DPI,
                       margin: float = 0.0,
                       whiten: Iterable[Sequence[float]] = (),
                       watch: Iterable[Sequence[float]] = (),
                       allowed: Iterable[Sequence[float]] = (),
                       strict: bool = False
                       ) -> WhitenDiff:
    """Planche côte à côte : zone sans blanchiment (gauche) / avec (droite)."""
    page = doc.doc[zone.page - 1]
    clip = crop_clip(doc, zone, margin)
    base = page.get_pixmap(dpi=dpi, clip=clip, alpha=False)
    cleaned = pymupdf.Pixmap(base)
    diff = whiten_pixmap(cleaned, clip, whiten, dpi, watch, allowed, strict) \
        if whiten else WhitenDiff()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    side_by_side(base, cleaned).save(str(out_path))
    return diff


def side_by_side(left: pymupdf.Pixmap, right: pymupdf.Pixmap,
                 gap: int = 8) -> pymupdf.Pixmap:
    """Assemble deux pixmaps horizontalement sur fond blanc."""
    width = left.width + gap + right.width
    height = max(left.height, right.height)
    out = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height), False)
    out.clear_with(255)
    destination = out.samples_mv
    for source, offset in ((left, 0), (right, left.width + gap)):
        channels = min(source.n, out.n)
        span = source.width * channels
        for y in range(source.height):
            start = y * source.stride
            dest = y * out.stride + offset * out.n
            destination[dest:dest + span] = source.samples[start:start + span]
    return out


def ink_pixels(pixmap: pymupdf.Pixmap, clip: pymupdf.Rect,
               rect: Sequence[float], exclude: Iterable[Sequence[float]] = (),
               dpi: int = DPI, threshold: int = 200) -> int:
    """Nombre de pixels d'encre (non blancs) dans un rectangle PDF.

    Sert au contrôle des fragments : une zone de la bbox d'un mot étranger qui
    reste sombre dans l'image montre bien un morceau de glyphe. Les rectangles
    `exclude` (glyphes propres de la région) sont ignorés : leur encre est
    légitime.
    """
    scale = dpi / 72.0
    n = pixmap.n
    stride = pixmap.stride
    samples = pixmap.samples_mv
    x0 = max(0, int((rect[0] - clip.x0) * scale))
    x1 = min(pixmap.width, _ceil_px((rect[2] - clip.x0) * scale))
    y0 = max(0, int((rect[1] - clip.y0) * scale))
    y1 = min(pixmap.height, _ceil_px((rect[3] - clip.y0) * scale))
    if x1 <= x0 or y1 <= y0:
        return 0
    skip = []
    for box in exclude:
        skip.append((
            max(0, int((box[0] - clip.x0) * scale)),
            max(0, int((box[1] - clip.y0) * scale)),
            min(pixmap.width, _ceil_px((box[2] - clip.x0) * scale)),
            min(pixmap.height, _ceil_px((box[3] - clip.y0) * scale)),
        ))
    count = 0
    for y in range(y0, y1):
        base = y * stride
        for x in range(x0, x1):
            if any(sx0 <= x < sx1 and sy0 <= y < sy1
                   for sx0, sy0, sx1, sy1 in skip):
                continue
            start = base + x * n
            if min(samples[start:start + 3]) < threshold:
                count += 1
    return count


# --- planches de contrôle -------------------------------------------------

COLORS = {
    "statement": (0.13, 0.36, 0.86),   # bleu
    "part": (0.17, 0.55, 0.25),        # vert
    "answer": (0.85, 0.40, 0.05),      # orange
    "solution": (0.85, 0.40, 0.05),    # orange
    "body": (0.55, 0.55, 0.55),        # gris (zone utile de la page)
}


def render_review_page(path: str, page_number: int,
                       boxes: Iterable[tuple[str, str, Sequence[float]]],
                       out_path: Path, dpi: int = 110,
                       body: tuple[float, float] | None = None) -> None:
    """Rend une page du PDF avec les rectangles détectés dessinés.

    boxes : suite de (type, étiquette, rect) avec type dans COLORS.
    body : (haut, bas) de la zone utile ; dessinée en gris pointillé.
    """
    doc = pymupdf.open(path)
    try:
        page = doc[page_number - 1]
        for kind, label, rect in boxes:
            color = COLORS.get(kind, (0.5, 0.5, 0.5))
            page.draw_rect(pymupdf.Rect(rect), color=color, width=1.1)
            if label:
                page.insert_text((rect[0] + 1.5, max(rect[1] - 2, 6)),
                                 label, fontsize=6.5, color=color)
        if body is not None:
            top, bottom = body
            for y in (top, bottom):
                page.draw_line((0, y), (page.rect.width, y),
                               color=COLORS["body"], width=0.7,
                               dashes="[3 3] 0")
        pixmap = page.get_pixmap(dpi=dpi, alpha=False)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        pixmap.save(str(out_path))
    finally:
        doc.close()

"""Lecture de la géométrie d'une page PDF.

Ce module ne connaît ni les exercices ni les solutions : il expose le texte
lignes par lignes (avec polices et drapeaux), les dessins vectoriels, les
images, et quelques outils de mise en page (lignes répétées en haut/bas de
page, regroupement en rangées visuelles, marges réelles du texte).

Toutes les coordonnées sont en points PDF, origine en haut à gauche.
"""

from __future__ import annotations

import re
import math
from collections import Counter
from dataclasses import dataclass
from typing import Iterable, Sequence

import pymupdf

# Bande de page considérée comme en-tête / pied de page. Les en-têtes des trois
# polycopiés vivent entre y=28 et y=46, les pieds entre y=762 et y=781 ; le
# texte courant descend au plus haut à y=56 et au plus bas à y=753.
HEADER_BAND = 52.0
FOOTER_BAND = 756.0

# Filet horizontal : hauteur négligeable et largeur au moins égale à celle du
# corps de texte. Ce sont les filets d'en-tête/pied et les séparateurs.
RULE_MAX_HEIGHT = 2.5
RULE_MIN_WIDTH = 200.0

# Marge de sécurité appliquée au corps de la page (zone utile) : on ne rend
# jamais un rectangle en dehors. Quand une page n'a ni filet ni pied détecté
# (géométrie), le corps s'arrête à cette distance du bas de la page.
BODY_BOTTOM_FALLBACK = 60.0

# Marge droite maximale d'une découpe (cf. cahier des charges).
MAX_RIGHT = 555.0
MIN_RIGHT = 480.0

MARGIN = 4.0

# Demi-point de garde appliqué au rendu autour de chaque rectangle blanchi
# (anticrénelage des bords). Le blanchiment soustrait les glyphes propres
# dilatés de cette valeur pour ne jamais ronger un glyphe de la région.
WHITEN_PAD = 0.35


def _norm_furniture(text: str) -> str:
    """Normalise une ligne pour repérer les en-têtes répétés.

    Les numéros de page changent d'une page à l'autre : on les remplace par un
    jeton neutre, comme le numéro de chapitre imprimé à gauche.
    """
    text = re.sub(r"\d+", "#", text)
    return re.sub(r"\s+", " ", text).strip().lower()


@dataclass(frozen=True)
class Span:
    text: str
    font: str
    size: float
    flags: int
    bbox: tuple[float, float, float, float]
    # Point d'origine du span : la ligne de base de la formule, bien plus
    # fiable que la bbox pour dire à quelle rangée un glyphe appartient (une
    # bbox de radical s'étale sur deux rangées).
    origin: tuple[float, float] = (0.0, 0.0)
    page: int = 0

    @property
    def bold(self) -> bool:
        return bool(self.flags & 16) or "Bold" in self.font or "SemiBold" in self.font

    @property
    def x0(self) -> float:
        return self.bbox[0]

    @property
    def x1(self) -> float:
        return self.bbox[2]

    @property
    def baseline(self) -> float:
        """Ordonnée de la ligne de base du glyphe."""
        return self.origin[1]

    @property
    def ink_box(self) -> tuple[float, float, float, float]:
        """Bbox de l'encre du glyphe (et non de sa chasse déclarée).

        Les radicaux des polices Computer Modern (CMSY10 « √ ») déclarent une
        bbox décalée d'une hauteur d'œil vers le haut : leur encre est en
        réalité *sous* l'origine. Toute décision géométrique (propriété du
        glyphe, étendue de la zone, blanchiment) doit utiliser cette boîte,
        sinon on blanchit du blanc au-dessus du radical et on laisse le trait
        du voisin.
        """
        if "\u221a" in self.text:
            depth = RADICAL_INK_DEPTH * (self.size or 12.0)
            return (self.bbox[0], self.baseline, self.bbox[2],
                    self.baseline + depth)
        return self.bbox

    @property
    def key(self) -> tuple:
        """Identité stable d'un span (propriété au rendu)."""
        return ((self.page,) + tuple(round(float(v), 3) for v in self.bbox)
                + (self.text, self.font))


# Glyphes d'extension : grandes accolades, pièces de radical, barres de racine.
# Leur bbox ne reflète pas leur encre et leur origine est posée au hasard par le
# graveur : ils suivent le span de base qu'ils accompagnent sur la même ligne.
STRUCTURAL_CHARS = ("\u221a",)
# Profondeur d'encre d'un radical, en hauteur d'œil (mesurée sur le polycopié).
RADICAL_INK_DEPTH = 0.78


def is_extension_span(span: Span) -> bool:
    """Vrai si le glyphe est une extension (accolade, radical, barre CMEX)."""
    if "EX" in span.font:
        return True
    if any(char in span.text for char in STRUCTURAL_CHARS):
        return True
    return any("\x0b" <= char <= "\x1f" or char == "\ufffd"
               for char in span.text)


def line_key(page: int, bbox: Sequence[float], text: str) -> tuple:
    """Clé stable d'une ligne de texte (les bbox sont réelles, non arrondies).

    Elle sert à savoir, au moment du rendu, à quelle région appartient chaque
    span sans garder d'objets Python en mémoire (les zones sont recalculées
    puis rendues par deux passages distincts).
    """
    return (page,) + tuple(round(float(v), 3) for v in bbox) + (text,)


@dataclass(frozen=True)
class Line:
    """Une ligne de texte telle que produite par get_text("dict")."""

    page: int
    bbox: tuple[float, float, float, float]
    spans: tuple[Span, ...]

    @property
    def key(self) -> tuple:
        """Identité stable d'une ligne (sert à tracer son propriétaire)."""
        return line_key(self.page, self.bbox, self.text)

    @property
    def x0(self) -> float:
        return self.bbox[0]

    @property
    def y0(self) -> float:
        return self.bbox[1]

    @property
    def x1(self) -> float:
        return self.bbox[2]

    @property
    def y1(self) -> float:
        return self.bbox[3]

    @property
    def text(self) -> str:
        return "".join(s.text for s in self.spans)

    @property
    def bold(self) -> bool:
        visible = [s for s in self.spans if s.text.strip()]
        return bool(visible) and all(s.bold for s in visible)

    @property
    def size(self) -> float:
        sizes = [s.size for s in self.spans if s.text.strip()]
        return max(sizes) if sizes else 0.0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    @property
    def origin_y(self) -> float:
        """Ligne de base de la ligne (origine la plus basse des glyphes pleins).

        C'est l'ordonnée qui décide de la rangée : une bbox de ligne peut
        s'étaler sur deux rangées (radical, exposant), pas la ligne de base.
        """
        baselines = [s.origin[1] for s in self.spans if s.text.strip()]
        return max(baselines) if baselines else (self.y0 + self.y1) / 2

    @property
    def span_keys(self) -> frozenset:
        return frozenset(s.key for s in self.spans if s.text)

    @property
    def ink_bbox(self) -> tuple[float, float, float, float]:
        """Union des boîtes d'encre des glyphes de la ligne.

        La bbox d'une ligne est gonflée par les glyphes d'extension (un radical
        déclare sa boîte une hauteur d'œil trop haut) : pour décider si une
        ligne chevauche la rangée d'un marqueur, c'est l'encre qui compte.
        """
        boxes = [s.ink_box for s in self.spans if s.text.strip()]
        if not boxes:
            return self.bbox
        return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))


# Surlignage cyan des titres d'exercice (#BFEAFB).
HIGHLIGHT_FILL = (0.7254, 0.8996, 0.9823)


@dataclass(frozen=True)
class Graphic:
    """Dessin vectoriel ou image placée sur la page."""

    page: int
    bbox: tuple[float, float, float, float]
    kind: str  # "drawing" | "image"
    fill: tuple[float, ...] | None = None
    # Le tracé sort de la page : sa bbox est celle du chemin, pas celle de
    # l'encre visible (une courbe qui plonge sous la page, une grille qui la
    # traverse). Ce n'est pas une figure : l'englober étirerait la découpe.
    clipped: bool = False

    @property
    def x0(self) -> float:
        return self.bbox[0]

    @property
    def y0(self) -> float:
        return self.bbox[1]

    @property
    def x1(self) -> float:
        return self.bbox[2]

    @property
    def y1(self) -> float:
        return self.bbox[3]

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    @property
    def decorative(self) -> bool:
        # Filets horizontaux (trait de titre, pied de bloc), surlignage cyan
        # du titre d'exercice et masques blancs posés derrière une figure :
        # ils ne comptent pas comme des figures.
        if self.height <= 2.5 and self.width >= 60:
            return True
        if self.fill is not None and len(self.fill) >= 3:
            if all(abs(self.fill[i] - HIGHLIGHT_FILL[i]) < 0.05 for i in range(3)):
                return True
            if all(self.fill[i] >= 0.97 for i in range(3)):
                return True
        return False

    @property
    def is_rule(self) -> bool:
        """Filet horizontal qui barre le corps de page (en-tête ou pied)."""
        return (self.kind == "drawing" and self.height <= RULE_MAX_HEIGHT
                and self.width >= RULE_MIN_WIDTH)

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2)


@dataclass(frozen=True)
class Row:
    """Rangée visuelle : plusieurs lignes de texte à la même hauteur.

    Sert à lire « Exercice 1.3 » + « Le prix d'un bain » comme une seule ligne,
    et à repérer les sous-questions sur deux colonnes.
    """

    page: int
    lines: tuple[Line, ...]

    @property
    def x0(self) -> float:
        return min(l.x0 for l in self.lines)

    @property
    def y0(self) -> float:
        return min(l.y0 for l in self.lines)

    @property
    def x1(self) -> float:
        return max(l.x1 for l in self.lines)

    @property
    def y1(self) -> float:
        return max(l.y1 for l in self.lines)

    @property
    def text(self) -> str:
        return " ".join(l.text.strip() for l in self.lines if l.text.strip())


class PageLayout:
    def __init__(self, index: int, width: float, height: float,
                 lines: list[Line], body: list[Line], graphics: list[Graphic],
                 body_top: float = 0.0, body_bottom: float = 0.0):
        self.index = index          # 0-based
        self.number = index + 1     # 1-based, tel qu'utilisé dans le catalogue
        self.width = width
        self.height = height
        self.lines = lines          # toutes les lignes (en-têtes compris)
        self.body = body            # lignes du texte courant
        self.graphics = graphics    # dessins et images (filets compris)
        # Zone utile de la page : sous l'en-tête et au-dessus du pied.
        self.body_top = body_top
        self.body_bottom = body_bottom or (height - BODY_BOTTOM_FALLBACK)
        self._rows: list[Row] | None = None

    # --- géométrie -------------------------------------------------------
    @property
    def rows(self) -> list[Row]:
        if self._rows is None:
            self._rows = build_rows(self.body)
        return self._rows

    def clamp_to_body(self, rect: Sequence[float]) -> tuple[float, float, float, float]:
        """Ramène un rectangle dans la zone utile (hors en-tête et pied).

        Les bords sont arrondis vers l'intérieur (au dixième de point) pour
        qu'un rectangle arrondi ne dépasse jamais la zone utile.
        """
        x0, y0, x1, y1 = rect
        y0 = max(y0, self.body_top)
        y1 = min(y1, self.body_bottom)
        y0 = math.ceil(y0 * 10) / 10
        y1 = math.floor(y1 * 10) / 10
        return (x0, y0, x1, y1)

    def in_body(self, bbox: Sequence[float]) -> bool:
        """Vrai si le centre d'une bbox est dans la zone utile de la page."""
        cy = (bbox[1] + bbox[3]) / 2
        return self.body_top <= cy <= self.body_bottom

    @property
    def content_right(self) -> float:
        """Marge droite réelle du texte courant (527 en impair, 550 en pair)."""
        rights = [l.x1 for l in self.body if l.text.strip()]
        if not rights:
            return MAX_RIGHT
        return min(MAX_RIGHT, max(MIN_RIGHT, max(rights) + 1.0))

    @property
    def content_left(self) -> float:
        lefts = [l.x0 for l in self.body if l.text.strip()]
        return min(lefts) if lefts else 45.0

    @property
    def content_bottom(self) -> float:
        """Dernier point occupé par du texte ou une figure (hors filets)."""
        ys = [l.y1 for l in self.body if l.text.strip()]
        ys += [g.y1 for g in self.graphics if not g.decorative and not g.clipped]
        return max(ys) if ys else self.height

    def figures(self) -> list[Graphic]:
        """Figures de la page : dessins pleins et images, sans les tracés
        débordants (leur bbox n'est pas celle de l'encre)."""
        return [g for g in self.graphics
                if not g.decorative and not g.clipped and g.height > 3]

    def text_in(self, rect: Sequence[float]) -> str:
        """Texte contenu dans un rectangle (utile aux tests et au contrôle)."""
        x0, y0, x1, y1 = rect
        out = []
        for line in self.body:
            cx = (max(line.x0, x0), min(line.x1, x1))
            cy = (max(line.y0, y0), min(line.y1, y1))
            if cx[1] > cx[0] and cy[1] > cy[0]:
                out.append(line.text)
        return "\n".join(out)


def build_rows(lines: Iterable[Line], tolerance: float = 6.0) -> list[Row]:
    """Regroupe des lignes de texte en rangées visuelles (même hauteur)."""
    ordered = sorted(lines, key=lambda l: ((l.y0 + l.y1) / 2, l.x0))
    groups: list[list[Line]] = []
    for line in ordered:
        center = (line.y0 + line.y1) / 2
        placed = False
        for group in groups:
            gcenter = sum((l.y0 + l.y1) / 2 for l in group) / len(group)
            if abs(center - gcenter) <= tolerance:
                group.append(line)
                placed = True
                break
        if not placed:
            groups.append([line])
    rows = [Row(lines[0].page, tuple(sorted(g, key=lambda l: l.x0))) for g in groups]
    return sorted(rows, key=lambda r: (r.y0, r.x0))


class Document:
    """Un PDF ouvert, avec cache par page et détection des en-têtes/pieds."""

    def __init__(self, path: str):
        self.path = path
        self.doc = pymupdf.open(path)
        self._pages: dict[int, PageLayout] = {}
        self._body_ready: set[int] = set()
        self._furniture: set[str] | None = None
        self._bounds: dict[int, tuple[float, float]] = {}

    @property
    def page_count(self) -> int:
        return self.doc.page_count

    def close(self) -> None:
        self.doc.close()

    # --- extraction ------------------------------------------------------
    def _raw_page(self, index: int) -> PageLayout:
        layout = self._pages.get(index)
        if layout is not None:
            return layout

        page = self.doc[index]
        lines: list[Line] = []
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue  # les images sont récupérées via get_image_info
            for raw in block["lines"]:
                spans = tuple(
                    Span(s["text"], s["font"], s["size"], s["flags"],
                         tuple(s["bbox"]), tuple(s["origin"]), index + 1)
                    for s in raw["spans"]
                )
                text = "".join(s.text for s in spans)
                # une ligne faite de glyphes d'extension (accolade CMEX, dont
                # le texte extrait est un caractère de contrôle) porte de
                # l'encre : elle ne doit pas être ignorée, sinon son glyphe
                # n'appartient à personne et le blanchiment l'efface
                if not text.strip() and not any(
                        "\x00" <= char <= "\x1f" or char == "\ufffd"
                        for char in text):
                    continue
                lines.append(Line(index + 1, tuple(raw["bbox"]), spans))

        graphics: list[Graphic] = []
        page_rect = page.rect
        for drawing in page.get_drawings():
            raw = drawing["rect"]
            if raw.width < 0.3 and raw.height < 0.3:
                continue
            # certains tracés sortent de la page (courbes): on les ramène dans
            # le cadre de la page, et on ignore ce qui est entièrement dehors
            rect = raw & page_rect
            clipped = rect != raw
            # un filet horizontal a une hauteur nulle : `is_empty` le rejetterait
            if rect.width < 0.3 and rect.height < 0.3:
                continue
            fill = drawing.get("fill")
            graphics.append(Graphic(index + 1, tuple(rect), "drawing",
                                    tuple(fill) if fill else None, clipped))
        for info in page.get_image_info():
            bbox = info.get("bbox")
            if not bbox:
                continue
            rect = pymupdf.Rect(bbox) & page_rect
            if rect.is_empty:
                continue
            graphics.append(Graphic(index + 1, tuple(rect), "image"))

        lines.sort(key=lambda l: (l.bbox[1], l.bbox[0]))
        layout = PageLayout(index, page.rect.width, page.rect.height, lines, [], graphics)
        self._pages[index] = layout
        return layout

    def furniture(self) -> set[str]:
        """Lignes répétées en haut ou en bas des pages (en-têtes, pieds)."""
        if self._furniture is not None:
            return self._furniture
        top: Counter[str] = Counter()
        bottom: Counter[str] = Counter()
        for index in range(self.page_count):
            layout = self._raw_page(index)
            seen_top: set[str] = set()
            seen_bottom: set[str] = set()
            for line in layout.lines:
                text = line.text.strip()
                if not text:
                    continue
                key = _norm_furniture(text)
                if line.y1 <= HEADER_BAND + 18:
                    seen_top.add(key)
                if line.y0 >= FOOTER_BAND - 18:
                    seen_bottom.add(key)
            top.update(seen_top)
            bottom.update(seen_bottom)
        minimum = max(3, int(self.page_count * 0.15))
        repeated = {k for k, n in top.items() if n >= minimum}
        repeated |= {k for k, n in bottom.items() if n >= minimum}
        self._furniture = repeated
        return repeated

    def is_furniture(self, line: Line) -> bool:
        if line.y1 <= HEADER_BAND or line.y0 >= FOOTER_BAND:
            return True
        repeated = self.furniture()
        if line.y1 <= HEADER_BAND + 18 or line.y0 >= FOOTER_BAND - 18:
            return _norm_furniture(line.text) in repeated
        return False

    def page(self, index: int) -> PageLayout:
        """Page avec uniquement le texte courant (en-têtes/pieds retirés)."""
        layout = self._raw_page(index)
        if index in self._body_ready:
            return layout
        body = [l for l in layout.lines if not self.is_furniture(l)]
        body_top, body_bottom = self.body_bounds(index)
        self._pages[index] = PageLayout(
            layout.index, layout.width, layout.height,
            layout.lines, body, layout.graphics, body_top, body_bottom,
        )
        self._body_ready.add(index)
        return self._pages[index]

    def body_bounds(self, index: int) -> tuple[float, float]:
        """Zone utile d'une page : (sous l'en-tête, au-dessus du pied).

        L'en-tête est fait des lignes répétées en haut de page et du filet qui
        les souligne ; le pied, du filet horizontal et du nom de matière
        répétés en bas de page (y > ~760 pt). Tout rectangle de découpe est
        ramené dans cette zone : ni en-tête ni pied ne peuvent apparaître dans
        une image.
        """
        cached = self._bounds.get(index)
        if cached is not None:
            return cached
        layout = self._raw_page(index)
        repeated = self.furniture()
        tops: list[float] = []
        bottoms: list[float] = []
        for line in layout.lines:
            text = line.text.strip()
            if not text:
                continue
            if line.y1 <= HEADER_BAND + 18 and (
                    line.y1 <= HEADER_BAND
                    or _norm_furniture(text) in repeated):
                tops.append(line.y1)
            if line.y0 >= FOOTER_BAND - 18 and _norm_furniture(text) in repeated \
                    and re.search(r"[A-Za-zÀ-ÿ]{2}", text):
                bottoms.append(line.y0)
        for graphic in layout.graphics:
            if not graphic.is_rule:
                continue
            if graphic.y0 <= HEADER_BAND + 18:
                tops.append(graphic.y1)
            if graphic.y0 >= FOOTER_BAND:
                bottoms.append(graphic.y0)
        top = max(tops) + 1.0 if tops else 0.0
        bottom = (min(bottoms) - 0.5 if bottoms
                  else layout.height - BODY_BOTTOM_FALLBACK)
        result = (top, bottom)
        self._bounds[index] = result
        return result

    # --- tables des matières --------------------------------------------
    def toc(self) -> list[tuple[int, str, int]]:
        return [(level, title.strip(), page) for level, title, page in self.doc.get_toc()]


def rect_intersects(a: Sequence[float], b: Sequence[float], pad: float = 0.0) -> bool:
    return (a[0] - pad < b[2] and a[2] + pad > b[0]
            and a[1] - pad < b[3] and a[3] + pad > b[1])


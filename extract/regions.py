"""Propriété du contenu d'une page : à quelle région appartient chaque trace.

Le découpage (exercises.py, solutions.py) produit des rectangles qui, sur les
pages à deux colonnes, se chevauchent de quelques points : un cadre peut donc
contenir le bas du titre voisin, le haut de la ligne suivante ou la fin de la
réponse d'à côté. `RegionIndex` répond à la question « ce span / ce dessin
appartient-il au rectangle que je rends ? » et fournit la liste des bbox à
blanchir.

Deux modes de blanchiment (`WHITEN_MODE`) :

- ``"headings"`` (défaut, production) : on ne peint **que** les titres
  d'autres exercices/solutions (« Exercice N.M », « Solution N.M », leur fond
  cyan ou gris et le texte de titre à leur droite). Dans une sous-question, le
  titre du bloc qui la porte est lui aussi un en-tête (jamais le contenu de la
  réponse) : il est blanchi quand une grande accolade remonte dans sa bande.
  Tout le reste — lignes voisines, pieds de page, traits de tableau, cotes
  d'une figure — n'est jamais peint : un fragment de voisin est un défaut
  mineur, un symbole manquant rend l'exercice faux. Les en-têtes et pieds de
  page restent exclus par le *clamping* du rectangle à la zone de corps, pas
  par blanchiment.
- ``"all"`` : ancien comportement (tout contenu étranger), conservé pour
  comparaison, non utilisé en production.

Règles communes :

- chaque *glyphe* (span) est revendiqué par la zone qui le contient (voir
  `Zone.claims`, calculé pendant la découpe) ; la propriété se lit sur
  l'origine du glyphe et non sur sa bbox (un radical s'étale sur deux rangées) ;
- en mode ``"all"``, un span est gardé si la zone le revendique, blanchi sinon.
  Une ligne à cheval sur deux zones n'est jamais blanchie en bloc : seuls ses
  glyphes étrangers le sont ;
- un dessin vectoriel est rattaché à la ligne de texte la plus proche (les
  barres de racine et de fraction touchent leur formule) ; il est gardé si
  cette ligne est revendiquée, blanchi sinon (mode ``"all"`` seulement) ;
- les glyphes d'extension (grandes accolades, radicaux CMEX) dessinent bien
  au-delà de leur bbox : ils sont blanchis sur toute leur colonne en mode
  ``"all"``, sauf si la zone y a elle-même un délimiteur ;
- **le contenu de la zone n'est jamais blanchi** : les bbox des glyphes
  revendiqués sont dilatées puis soustraites de chaque rectangle blanc ; le
  contrôle final (`whiten_plan`) compte les glyphes propres encore touchés et
  doit toujours trouver 0 ;
- les images (bitmap) ne sont jamais blanchies.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from exercises import TITLE_RE, Block, Zone
from pdf_layout import (
    Document, PageLayout, WHITEN_PAD, is_extension_span,
)

# --- mode de blanchiment --------------------------------------------------
# ``headings`` (défaut) : seuls les titres d'autres exercices/solutions sont
# peints. ``all`` : tout contenu étranger (ancien comportement, comparaison).
DEFAULT_WHITEN_MODE = "headings"
WHITEN_MODES = ("headings", "all")
_whiten_mode = os.environ.get("WHITEN_MODE", DEFAULT_WHITEN_MODE).strip().lower()
if _whiten_mode not in WHITEN_MODES:
    _whiten_mode = DEFAULT_WHITEN_MODE


def set_whiten_mode(mode: str | None) -> str:
    """Fixe le mode de blanchiment (variable d'environnement ou option CLI)."""
    global _whiten_mode
    value = (mode or DEFAULT_WHITEN_MODE).strip().lower()
    if value not in WHITEN_MODES:
        raise ValueError(f"WHITEN_MODE inconnu : {mode!r} "
                         f"(attendu : {', '.join(WHITEN_MODES)})")
    _whiten_mode = value
    return _whiten_mode


def get_whiten_mode() -> str:
    return _whiten_mode


# Un dessin vectoriel plus grand que cela n'est pas un élément de formule :
# c'est une figure (ou un tracé de fond dont la bbox est peu fiable). Il n'est
# jamais blanchi, sinon on effacerait le dessin lui-même.
MAX_WHITEN_DRAWING_HEIGHT = 150.0
MAX_WHITEN_DRAWING_AREA = 20000.0

# Distance maximale (pt) entre un dessin et la ligne qui le porte.
OWNER_MAX_DISTANCE = 90.0
# Part de la surface d'un mot étranger qui doit être blanchie pour que le mot
# soit considéré comme invisible (marge pour l'anticrénelage et les jambages).
COVERAGE_OK = 0.97


def _area(rect: Sequence[float]) -> float:
    return max(0.0, rect[2] - rect[0]) * max(0.0, rect[3] - rect[1])


def _intersect(a: Sequence[float], b: Sequence[float]):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _clip(*rects: Sequence[float]):
    """Intersection d'un nombre quelconque de rectangles, ou None."""
    result = tuple(rects[0])
    for rect in rects[1:]:
        result = _intersect(result, rect)
        if result is None:
            return None
    return result


def _distance(rect: Sequence[float], x: float, y: float) -> tuple[float, float]:
    dx = max(rect[0] - x, 0.0, x - rect[2])
    dy = max(rect[1] - y, 0.0, y - rect[3])
    return dy, dx


def _column_reaches(bbox: Sequence[float], rect: Sequence[float],
                    reach: float = 20.0) -> bool:
    """Vrai si un glyphe (ou son encre possible) atteint le rectangle."""
    return (bbox[2] > rect[0] and bbox[0] < rect[2]
            and bbox[3] > rect[1] - reach and bbox[1] < rect[3] + reach)


def _white_mask(graphic) -> bool:
    """Masque blanc (fond de figure) : ne doit jamais être blanchi."""
    fill = graphic.fill
    return (graphic.kind == "drawing" and fill is not None
            and len(fill) >= 3 and all(channel >= 0.97 for channel in fill[:3]))


def _in_figure(bbox: Sequence[float], figures: Sequence[Sequence[float]],
               pad: float = 6.0) -> bool:
    """Vrai si le centre d'une bbox tombe dans une figure de la zone."""
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    return any(f[0] - pad <= cx <= f[2] + pad and f[1] - pad <= cy <= f[3] + pad
               for f in figures)


def _is_figure_label(bbox: Sequence[float],
                     figures: Sequence[Sequence[float]],
                     ratio: float = 0.8) -> bool:
    """Vrai si une ligne de texte est *contenue* dans une figure (étiquette).

    Le simple test du centre ne suffit pas : la bbox d'un tracé de graphique
    peut couvrir une grande partie de la page et contenir le centre d'une vraie
    ligne d'énoncé. Une étiquette (« a) », « 5 », « y ») est, elle, entièrement
    comprise dans la figure : on exige que l'intersection couvre presque toute
    la ligne (ou toute la figure, si elle est plus petite).
    """
    area = _area(bbox)
    if area <= 0:
        return False
    for figure in figures:
        piece = _intersect(bbox, figure)
        if piece is None:
            continue
        if _area(piece) >= ratio * min(area, _area(figure)):
            return True
    return False


def _same_column(bbox: Sequence[float], others: Sequence[Sequence[float]],
                 minimum: float = 0.6) -> bool:
    """Vrai si une bbox partage sa colonne avec l'une des bbox données."""
    width = max(bbox[2] - bbox[0], 0.1)
    for other in others:
        overlap = min(bbox[2], other[2]) - max(bbox[0], other[0])
        if overlap >= minimum * min(width, max(other[2] - other[0], 0.1)):
            return True
    return False


def _subtract(box: Sequence[float], blockers: Sequence[Sequence[float]]
              ) -> list[tuple[float, float, float, float]]:
    """Retire d'un rectangle les parties couvertes par d'autres rectangles.

    Sert à ne jamais blanchir le contenu de la zone elle-même : un rectangle
    étranger peut chevaucher un glyphe de la zone (formules très serrées).
    """
    pieces = [tuple(box)]
    for blocker in blockers:
        keep: list[tuple[float, float, float, float]] = []
        for piece in pieces:
            overlap = _intersect(piece, blocker)
            if overlap is None:
                keep.append(piece)
                continue
            x0, y0, x1, y1 = piece
            if overlap[1] > y0:                       # bande au-dessus
                keep.append((x0, y0, x1, overlap[1]))
            if overlap[3] < y1:                       # bande en dessous
                keep.append((x0, overlap[3], x1, y1))
            if overlap[0] > x0:                       # à gauche
                keep.append((x0, overlap[1], overlap[0], overlap[3]))
            if overlap[2] < x1:                       # à droite
                keep.append((overlap[2], overlap[1], x1, overlap[3]))
        pieces = keep
        if not pieces:
            break
    return [piece for piece in pieces if _area(piece) > 0.2]


def _column_gaps(bbox: Sequence[float], rect: Sequence[float],
                 allowed: Sequence[Sequence[float]]
                 ) -> list[tuple[float, float, float, float]]:
    """Tranches verticales d'une colonne, hors contenu autorisé de la zone."""
    x0, x1 = max(bbox[0], rect[0]), min(bbox[2], rect[2])
    if x1 <= x0:
        return []
    blocked = sorted(
        (box[1], box[3]) for box in allowed
        if box[2] > x0 and box[0] < x1 and box[3] > rect[1] and box[1] < rect[3]
    )
    out: list[tuple[float, float, float, float]] = []
    cursor = rect[1]
    for y0, y1 in blocked:
        if y0 > cursor:
            out.append((x0, cursor, x1, min(y0, rect[3])))
        cursor = max(cursor, y1)
        if cursor >= rect[3]:
            break
    if cursor < rect[3]:
        out.append((x0, cursor, x1, rect[3]))
    return [box for box in out if box[3] - box[1] > 0.2]


@dataclass
class Fragment:
    """Un mot étranger encore partiellement visible dans une découpe."""

    text: str
    page: int
    coverage: float
    bbox: tuple[float, float, float, float]


@dataclass
class WhitenPlan:
    """Résultat du calcul de blanchiment d'une découpe, avec son contrôle.

    - `boxes` : rectangles réellement peints en blanc ;
    - `protected` : glyphes propres qu'un rectangle *brut* aurait recouverts et
      que la soustraction a protégés (ils restent pleinement visibles) ;
    - `line_protected` : boîtes de ligne propres soustraites du blanchiment
      (exposants, indices, numérateurs, dénominateurs, radicaux, accolades et
      barres de fraction de la région) ;
    - `line_hits` : rectangles bruts qui mordaient sur une boîte de ligne sans
      toucher la bbox d'un glyphe propre (protection due à la boîte seule) ;
    - `dropped` : rectangles renoncés parce qu'ils touchaient encore un glyphe
      propre (la découpe est signalée `low_confidence`) ;
    - `own_hits` : glyphes propres touchés par un rectangle final — doit
      toujours valoir 0 ;
    - `allowed` : enveloppes des titres étrangers (dilatées) ; en mode
      ``headings``, toute encre effacée doit tomber dedans — c'est la seule
      différence autorisée entre le rendu final et le rendu brut ;
    - `mode` : mode utilisé pour ce plan.
    """

    boxes: list = field(default_factory=list)
    protected: int = 0
    dropped: int = 0
    own_hits: int = 0
    line_protected: int = 0
    line_hits: int = 0
    allowed: list = field(default_factory=list)
    mode: str = DEFAULT_WHITEN_MODE


@dataclass(frozen=True)
class TitleMark:
    """Titre d'exercice ou de solution repéré sur une page.

    `group` est le groupe du bloc propriétaire (`exercise-1.3`,
    `solution-1.3`) : une zone dont le groupe est identique ne blanchit jamais
    ce titre (c'est le sien). `marker` est la bbox des seuls mots
    « Exercice N.M » / « Solution N.M » (une ligne PDF peut mêler le titre et
    le début d'une formule : le titre s'arrête au numéro), `box` le fond coloré
    (cyan en algèbre/géométrie, gris en physique) et `lines` le texte de titre
    imprimé à droite *à l'intérieur* de ce fond (physique). Rien d'autre n'est
    peint : une formule voisine sur la même ligne n'est pas un titre.
    """

    group: str
    kind: str
    number: str
    marker: tuple[float, float, float, float]
    box: tuple[float, float, float, float]
    lines: tuple = ()

    @property
    def rect(self) -> tuple[float, float, float, float]:
        boxes = [self.marker, self.box] + [line.bbox for line in self.lines]
        return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))

    @property
    def pieces(self) -> tuple[tuple[float, float, float, float], ...]:
        """Rectangles à peindre pour effacer ce titre (et rien de plus)."""
        out = [self.marker, self.box]
        out += [line.bbox for line in self.lines]
        return tuple(out)


@dataclass
class RegionIndex:
    """Index des zones d'une matière, avec résolution de propriété au rendu."""

    doc: Document
    zones: dict[int, list[Zone]] = field(default_factory=dict)
    _owners: dict[int, list[tuple[tuple | None, float]]] = field(
        default_factory=dict, repr=False)
    _lines: dict[int, list] = field(default_factory=dict, repr=False)
    _words: dict[int, list] = field(default_factory=dict, repr=False)
    _spans: dict[int, dict] = field(default_factory=dict, repr=False)
    _line_map: dict[int, dict] = field(default_factory=dict, repr=False)
    _titles: dict[int, list[TitleMark]] = field(default_factory=dict,
                                               repr=False)

    # --- enregistrement --------------------------------------------------
    def add(self, zone: Zone | None) -> None:
        if zone is not None:
            self.zones.setdefault(zone.page, []).append(zone)

    def add_block(self, block: Block) -> None:
        for zone in block.statement:
            self.add(zone)
        for part in block.parts:
            self.add(part.question)
            for extra in part.extra_question:
                self.add(extra)

    # --- données de page -------------------------------------------------
    def page(self, number: int) -> PageLayout:
        return self.doc.page(number - 1)

    def lines(self, number: int) -> list:
        """Toutes les lignes de la page, en-têtes et pieds compris."""
        cached = self._lines.get(number)
        if cached is None:
            cached = self.page(number).lines
            self._lines[number] = cached
        return cached

    def words(self, number: int) -> list:
        cached = self._words.get(number)
        if cached is None:
            cached = self.doc.doc[number - 1].get_text("words")
            self._words[number] = cached
        return cached

    def span_map(self, number: int) -> dict:
        """Clé de span → (span, ligne) pour toute une page."""
        cached = self._spans.get(number)
        if cached is None:
            cached = {}
            for line in self.lines(number):
                for span in line.spans:
                    if span.text:
                        cached[span.key] = (span, line)
            self._spans[number] = cached
        return cached

    def line_map(self, number: int) -> dict:
        cached = self._line_map.get(number)
        if cached is None:
            cached = {line.key: line for line in self.lines(number)}
            self._line_map[number] = cached
        return cached

    # --- titres d'exercices et de solutions ------------------------------
    def titles(self, number: int) -> list[TitleMark]:
        """Titres (« Exercice N.M », « Solution N.M ») de la page."""
        cached = self._titles.get(number)
        if cached is None:
            cached = self._find_titles(number)
            self._titles[number] = cached
        return cached

    @staticmethod
    def _is_title_background(graphic) -> bool:
        """Fond de titre : petit rectangle plein (cyan ou gris) posé sur du texte.

        Les figures colorées (un carré cyan de croquis) sont bien plus hautes
        que 30 pt : elles ne peuvent pas être confondues avec un fond de titre.
        """
        return (graphic.kind == "drawing" and graphic.fill is not None
                and 6.0 <= graphic.height <= 30.0 and graphic.width <= 400.0)

    @staticmethod
    def _behind(box: Sequence[float], graphic) -> bool:
        """Vrai si le fond `graphic` porte la bbox `box`."""
        return (graphic.y0 - 1.0 <= box[1] and box[3] <= graphic.y1 + 1.0
                and graphic.x0 <= box[0] + 1.0
                and graphic.x1 >= box[2] - 1.0)

    def _find_titles(self, number: int) -> list[TitleMark]:
        page = self.page(number)
        backgrounds = [g for g in page.graphics
                       if self._is_title_background(g)]
        rows = page.rows
        words = self.words(number)
        out: list[TitleMark] = []
        for line in page.body:
            found = TITLE_RE.match(line.text.strip())
            if not found:
                continue
            kind = "exercise" if found.group(1) == "Exercice" else "solution"
            mark_number = found.group(2)
            marker = self._marker_box(line, words)
            behind = [g for g in backgrounds if self._behind(marker, g)]
            background = min(behind, key=lambda g: g.width * g.height) \
                if behind else None
            box = tuple(background.bbox) if background is not None else marker
            title_lines: list = []
            if background is not None:
                row = next((r for r in rows
                            if any(other.key == line.key for other in r.lines)),
                           None)
                for other in (row.lines if row is not None else ()):
                    if other.key == line.key:
                        continue
                    if not (background.y0 - 1.0 <= other.y0
                            and other.y1 <= background.y1 + 1.0):
                        continue
                    if not (background.x0 - 3.0 <= other.x0
                            and other.x1 <= background.x1 + 3.0):
                        continue
                    title_lines.append(other)
            out.append(TitleMark(
                group=f"{kind}-{mark_number}", kind=kind,
                number=mark_number, marker=marker, box=box,
                lines=tuple(title_lines)))
        return out

    @staticmethod
    def _marker_box(line, words: Sequence[Sequence]) -> tuple[float, float,
                                                             float, float]:
        """Bbox des mots « Exercice N.M » / « Solution N.M » dans une ligne.

        Une ligne PDF peut contenir le titre *et* le début d'une formule
        (« Solution 2.25 sin(α) = ± ») : le titre s'arrête au numéro, sinon on
        peindrait du contenu de solution en croyant effacer un titre.
        """
        inside = sorted(
            ((tuple(word[:4]), word[4]) for word in words
             if word[0] >= line.x0 - 1.0 and word[2] <= line.x1 + 1.0
             and word[1] >= line.y0 - 2.0 and word[3] <= line.y1 + 2.0),
            key=lambda item: item[0][0])
        for start in range(len(inside)):
            text = ""
            used = []
            for box, word in inside[start:start + 3]:
                text = (text + " " + word).strip()
                used.append(box)
                if TITLE_RE.match(text):
                    return (min(b[0] for b in used), min(b[1] for b in used),
                            max(b[2] for b in used), max(b[3] for b in used))
                if len(text) > 30:
                    break
        return tuple(line.bbox)

    def title_boxes(self, zone: Zone, include_own: bool = False
                    ) -> list[tuple[float, float, float, float]]:
        """Encre des titres comprise dans le rectangle.

        C'est la seule catégorie de contenu que le mode ``headings`` peint :
        les mots « Exercice N.M » / « Solution N.M », leur fond cyan/gris et le
        texte de titre porté par ce fond (physique). Le titre du bloc de la
        zone n'est peint que pour une *sous-question* (`include_own`) : un
        en-tête n'est jamais le contenu d'une réponse (géométrie 2.57 s-a, où
        la grande accolade remonte dans la bande du titre). Une formule voisine
        sur la même ligne n'est jamais prise pour un titre.
        """
        rect = zone.rect
        out: list[tuple[float, float, float, float]] = []
        for mark in self.titles(zone.page):
            if mark.group == zone.group and not include_own:
                continue
            for box in mark.pieces:
                piece = _intersect(box, rect)
                if piece is not None:
                    out.append(piece)
        return out

    def _heading_candidates(self, zone: Zone) -> list[tuple[float, float, float, float]]:
        # un titre n'est jamais le contenu d'une sous-question : dans une
        # réponse, même le titre du bloc est un en-tête (il est blanchi) ;
        # dans un énoncé ou une solution, seul le titre des autres blocs l'est.
        return self.title_boxes(zone, include_own=zone.role == "part")

    def own_spans(self, zone: Zone) -> list:
        """Glyphes revendiqués par la zone (texte de la région)."""
        index = self.span_map(zone.page)
        return [index[key][0] for key in zone.claims if key in index]

    def own_glyphs(self, zone: Zone) -> list[tuple[float, float, float, float]]:
        """Bbox des glyphes propres, restreintes au rectangle (contrôle)."""
        rect = zone.rect
        out = []
        for span in self.own_spans(zone):
            if not span.text.strip():
                continue
            piece = _intersect(span.ink_box, rect)
            if piece is not None:
                out.append(piece)
        return out

    def own_line_boxes(self, zone: Zone) -> list[tuple[float, float, float, float]]:
        """Boîtes de ligne propres : tout ce qui appartient visuellement à la zone.

        Une attribution par origine peut envoyer un exposant (origine plus haute
        que la ligne de base) ou un indice (plus basse) vers une autre région ;
        la boîte de ligne est une protection *indépendante* de cette
        attribution. Pour chaque ligne dont la zone revendique au moins un
        glyphe :

        - la bande verticale est celle de la ligne de base de chaque glyphe
          propre, élargie de 0,6 × taille de police : un exposant ou un indice,
          dont l'origine est décalée de moins d'une demi-hauteur d'œil, tombe
          dans la bande ;
        - l'abscisse doit être comprise entre le premier et le dernier glyphe de
          la ligne ;
        - la boîte est l'union des bbox de *tous* les glyphes de la page qui
          satisfont ces deux conditions (pas seulement des glyphes revendiqués).

        Exposants, indices, numérateurs, dénominateurs, radicaux, accolades et
        barres de fraction situés dans cette boîte sont donc toujours conservés
        au rendu. Le résultat est restreint au rectangle de la zone.
        """
        rect = zone.rect
        index = self.span_map(zone.page)
        own_lines: dict[tuple, tuple] = {}
        for key in zone.claims:
            item = index.get(key)
            if item is None:
                continue
            span, line = item
            if not span.text.strip():
                continue
            own_lines.setdefault(line.key, (line, []))[1].append(span)
        if not own_lines:
            return []
        page_spans = [span for line in self.lines(zone.page) for span in line.spans]
        out: list[tuple[float, float, float, float]] = []
        for line, own in own_lines.values():
            bands = []
            for span in own:
                size = span.size or 12.0
                bands.append((span.baseline - 0.6 * size,
                              span.baseline + 0.6 * size))
            boxes = []
            for other in page_spans:
                if not other.text:
                    continue
                origin = other.origin[1]
                if not any(top <= origin <= bottom for top, bottom in bands):
                    continue
                centre = (other.bbox[0] + other.bbox[2]) / 2
                if not (line.x0 - 0.5 <= centre <= line.x1 + 0.5):
                    continue
                boxes.append(other.bbox)
            if not boxes:
                continue
            box = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                   max(b[2] for b in boxes), max(b[3] for b in boxes))
            piece = _intersect(box, rect)
            if piece is not None:
                out.append(piece)
        return out

    def owners(self, number: int) -> list[tuple[tuple | None, float]]:
        """Pour chaque dessin de la page : (clé de la ligne porteuse, distance)."""
        cached = self._owners.get(number)
        if cached is not None:
            return cached
        layout = self.page(number)
        lines = layout.lines
        owners: list[tuple[tuple | None, float]] = []
        for graphic in layout.graphics:
            if graphic.kind != "drawing":
                owners.append((None, 0.0))
                continue
            cx, cy = graphic.center
            best: tuple | None = None
            best_dist = OWNER_MAX_DISTANCE
            for line in lines:
                dy, dx = _distance(line.bbox, cx, cy)
                # la verticalité pèse plus lourd : une barre de racine est
                # collée à sa formule, pas à la ligne de la colonne voisine
                dist = dy * 3.0 + dx
                if dist < best_dist:
                    best, best_dist = line.key, dist
            owners.append((best, best_dist))
        self._owners[number] = owners
        return owners

    # --- décision de blanchiment ----------------------------------------
    def whiten_plan(self, zone: Zone, mode: str | None = None) -> WhitenPlan:
        """Rectangles à peindre en blanc, et contrôle du contenu propre.

        En mode ``headings`` (défaut), seuls les titres d'autres exercices /
        solutions sont candidats ; en mode ``all``, tout contenu étranger.
        Dans les deux cas, les bbox des glyphes propres (dilatées d'un
        demi-point pour absorber l'anticrénelage) sont soustraites des
        rectangles : un rectangle ne peut donc jamais mordre sur le contenu de
        la région courante. Un contrôle final recompte les glyphes propres
        touchés ; il doit trouver 0.
        """
        mode = (mode or _whiten_mode).strip().lower()
        if mode not in WHITEN_MODES:
            raise ValueError(f"WHITEN_MODE inconnu : {mode!r}")
        if mode == "all":
            candidates = self._all_candidates(zone)
        else:
            candidates = self._heading_candidates(zone)

        own = self.own_glyphs(zone)
        line_boxes = self.own_line_boxes(zone)
        # La protection est double et indépendante : les bbox des glyphes
        # revendiqués, et les boîtes de ligne (qui contiennent aussi les
        # exposants, indices et fragments de formule situés sur la même bande).
        # La garde de la boîte de ligne couvre l'arrondi pixel du rendu : un
        # rectangle blanc ne peut pas mordre d'un pixel sur elle.
        line_guard = _protect(line_boxes, WHITEN_PAD + 0.6)
        protected_boxes = _protect(own) + line_guard
        plan = WhitenPlan(mode=mode)
        plan.line_protected = len(line_boxes)
        plan.protected = sum(1 for glyph in own
                             if any(_intersect(glyph, box) for box in candidates))
        plan.line_hits = sum(
            1 for box in candidates
            if any(_intersect(box, blocker) for blocker in line_guard)
            and not any(_intersect(box, glyph) for glyph in own))
        survivors: list[tuple[float, float, float, float]] = []
        for box in candidates:
            for piece in _subtract(box, protected_boxes):
                if any(_intersect(glyph, piece) for glyph in own):
                    plan.dropped += 1
                    continue
                survivors.append(piece)
        plan.boxes = _merge(survivors)
        plan.own_hits = sum(1 for glyph in own
                            if any(_intersect(glyph, box) for box in plan.boxes))
        # Enveloppes des titres étrangers (dans une sous-question, le titre du
        # bloc est aussi un en-tête) : en mode headings, tout pixel effacé doit
        # tomber dedans (contrôle indépendant dans render.whiten_pixmap).
        plan.allowed = _protect(
            self.title_boxes(zone, include_own=zone.role == "part"), 1.0)
        return plan

    def _all_candidates(self, zone: Zone) -> list[tuple[float, float, float, float]]:
        """Mode ``all`` : glyphes et dessins de toutes les autres régions."""
        page = self.page(zone.page)
        rect = zone.rect
        allowed = self._allowed_boxes(zone)
        own_delimiters = self._claimed_delimiters(zone)
        candidates: list[tuple[float, float, float, float]] = []

        for line in self.lines(zone.page):
            if _is_figure_label(line.bbox, zone.figures):
                # étiquette d'une figure de la zone : elle fait partie du dessin
                continue
            if line.key not in zone.lines:
                # ligne entièrement étrangère : sa bbox (et non celle de chaque
                # span) permet de nettoyer l'encre qui déborde des glyphes
                clipped = _intersect(line.bbox, rect)
                if clipped is not None:
                    candidates.append(clipped)
            for span in line.spans:
                if not span.text or span.key in zone.claims:
                    continue
                if is_extension_span(span) and _column_reaches(span.ink_box, rect) \
                        and not _same_column(span.ink_box, own_delimiters):
                    # un grand délimiteur (CMEX) a une bbox bien plus petite que
                    # son encre : on blanchit toute la colonne du glyphe, sauf
                    # si la zone y a elle-même un délimiteur (ce serait effacer
                    # notre accolade ou notre radical)
                    candidates.extend(_column_gaps(span.ink_box, rect, allowed))
                clipped = _intersect(span.ink_box, rect)
                if clipped is not None:
                    candidates.append(clipped)

        figures = zone.figures
        for graphic, (owner, _dist) in zip(page.graphics, self.owners(zone.page)):
            if graphic.kind == "image":
                continue  # une image n'est jamais blanchie
            if _white_mask(graphic):
                # masque blanc posé derrière une figure : blanchir par-dessus
                # effacerait le dessin lui-même
                continue
            if graphic.height > MAX_WHITEN_DRAWING_HEIGHT or \
                    graphic.width * graphic.height > MAX_WHITEN_DRAWING_AREA:
                # figure (courbe, axe, cadre) : ses bbox sont peu fiables et la
                # blanchir effacerait le dessin
                continue
            clipped = _intersect(graphic.bbox, rect)
            if clipped is None:
                # un filet de formule (barre de fraction, vinculum) a une bbox
                # de hauteur nulle : on l'élargit d'un demi-point pour effacer
                # aussi le trait qui dépasse dans la découpe
                clipped = _intersect(
                    (graphic.x0 - WHITEN_PAD, graphic.y0 - WHITEN_PAD,
                     graphic.x1 + WHITEN_PAD, graphic.y1 + WHITEN_PAD), rect)
            if clipped is None:
                continue
            cx, cy = graphic.center
            if _in_figure((cx, cy, cx, cy), figures):
                continue
            if owner is not None and owner in zone.lines:
                continue
            candidates.append(clipped)
        return candidates

    def foreign_boxes(self, zone: Zone,
                      mode: str | None = None
                      ) -> list[tuple[float, float, float, float]]:
        """Portions du rectangle à peindre en blanc (selon le mode courant)."""
        return self.whiten_plan(zone, mode).boxes

    def _claimed_delimiters(self, zone: Zone) -> list[tuple[float, float, float, float]]:
        """Colonnes des grands délimiteurs revendiqués par la zone."""
        return [tuple(span.ink_box) for span in self.own_spans(zone)
                if is_extension_span(span)]

    def _allowed_boxes(self, zone: Zone) -> list[tuple[float, float, float, float]]:
        """Glyphes de texte de la zone : jamais blanchis.

        Ce sont les bbox des spans (plus serrées que celles des lignes) : le
        blanchiment peut ainsi nettoyer les blancs entre deux spans d'une même
        ligne sans jamais toucher aux glyphes de la zone. Les figures de la zone
        ne sont pas incluses : elles protègent leurs dessins (boucle dédiée) et
        leurs étiquettes, pas le texte voisin.
        """
        return self.own_glyphs(zone)

    # --- contrôle --------------------------------------------------------
    def visible_text(self, zone: Zone) -> str:
        """Texte réellement visible dans la découpe (après blanchiment)."""
        rows: list[tuple[float, float, str]] = []
        for word in self._inside_words(zone):
            rows.append((word[1], word[0], word[4]))
        rows.sort()
        return "\n".join(text for _y, _x, text in rows)

    def visible_words(self, zone: Zone) -> list[str]:
        return [word[4] for word in self._inside_words(zone)]

    def _word_claimed(self, zone: Zone, number: int,
                      bbox: Sequence[float]) -> bool:
        """Vrai si un mot appartient à la région courante (glyphes revendiqués)."""
        key = self._word_line(number, bbox)
        if key is None:
            return False
        line = self.line_map(number).get(key)
        if line is None:
            return False
        for span in line.spans:
            if span.key in zone.claims and span.text \
                    and _intersect(span.ink_box, bbox) is not None:
                return True
        return False

    def _inside_words(self, zone: Zone) -> list[list]:
        page = self.page(zone.page)
        rect = zone.rect
        out: list[list] = []
        for word in self.words(zone.page):
            bbox = tuple(word[:4])
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            if not (rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3]):
                continue
            if not page.in_body(bbox):
                continue
            if self._word_claimed(zone, zone.page, bbox):
                out.append(word)
        return out

    def _word_line(self, number: int, bbox: Sequence[float]) -> tuple | None:
        best: tuple | None = None
        best_area = 0.0
        for line in self.lines(number):
            overlap = _intersect(line.bbox, bbox)
            if overlap is None:
                continue
            area = _area(overlap)
            if area > best_area:
                best, best_area = line.key, area
        return best

    def residuals(self, zone: Zone) -> list[Fragment]:
        """Mots étrangers au rectangle qui resteraient partiellement visibles.

        On liste les mots dont le centre est dans le rectangle, qui ne sont pas
        revendiqués par la zone, et dont la *surface de glyphes* (bbox du mot
        restreinte aux spans de sa ligne, donc sans les blancs entre spans)
        n'est pas entièrement couverte par le blanchiment : un fragment de
        glyphe subsisterait dans l'image.

        Les boîtes de ligne propres comptent comme du contenu légitime : une
        encre qui tombe dedans est protégée volontairement (exposant, indice,
        barre de fraction de la région), ce n'est pas un fragment étranger.
        """
        page = self.page(zone.page)
        rect = zone.rect
        boxes = self.foreign_boxes(zone)
        # les boîtes de ligne propres (avec leur garde d'anticrénelage) sont du
        # contenu légitime : l'encre qui y tombe est protégée volontairement
        legit = list(boxes) + _protect(self.own_line_boxes(zone), 1.0)
        out: list[Fragment] = []
        for word in self.words(zone.page):
            bbox = tuple(word[:4])
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            if not (rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3]):
                continue
            if not page.in_body(bbox):
                continue
            if self._word_claimed(zone, zone.page, bbox):
                continue
            if _in_figure(bbox, zone.figures):
                continue  # étiquette de figure : conservée volontairement
            # la bande centrale du mot porte l'encre ; les jambages de la bbox
            # (ascendantes/descendantes) ne comptent pas comme visibles. Seule
            # la partie de la bande visible dans le cadre est mesurée : un mot
            # à cheval sur le bord n'est un fragment que si son morceau visible
            # n'est pas blanchi.
            height = bbox[3] - bbox[1]
            band = _clip((bbox[0], bbox[1] + 0.3 * height,
                          bbox[2], bbox[3] - 0.3 * height), rect)
            if band is None:
                continue
            glyphs, covered = self._coverage(zone.page, band, rect, legit)
            if glyphs <= 0:
                continue
            coverage = min(1.0, covered / glyphs)
            if coverage < COVERAGE_OK:
                out.append(Fragment(word[4], zone.page, coverage, bbox))
        return out

    def _coverage(self, number: int, band: Sequence[float],
                  rect: Sequence[float], boxes: Sequence[Sequence[float]]
                  ) -> tuple[float, float]:
        """Surface de glyphes dans une bande, et part couverte par le blanc.

        Chaque glyphe est mesuré une fois (une accolade et son indice se
        chevauchent) et sa couverture est plafonnée à sa propre surface : un
        mot n'est un fragment que si de l'encre étrangère reste visible.
        """
        glyphs = covered = 0.0
        key = self._word_line(number, band)
        for line in self.lines(number):
            if key is not None and line.key != key:
                continue
            for span in line.spans:
                if not span.text.strip():
                    continue
                piece = _clip(band, span.ink_box, rect)
                if piece is None:
                    continue
                area = _area(piece)
                glyphs += area
                hit = 0.0
                for box in boxes:
                    piece_hit = _intersect(piece, box)
                    if piece_hit is not None:
                        hit += _area(piece_hit)
                covered += min(area, hit)
        return glyphs, covered

    def _glyph_area(self, number: int, bbox: Sequence[float],
                    rect: Sequence[float]) -> float:
        """Surface du mot réellement occupée par des glyphes dans le cadre."""
        return self._coverage(number, bbox, rect, ())[0]


def _protect(glyphs: Iterable[Sequence[float]],
             pad: float = WHITEN_PAD) -> list[tuple[float, ...]]:
    """Glyphes propres dilatés : zone interdite au blanchiment."""
    return [(g[0] - pad, g[1] - pad, g[2] + pad, g[3] + pad) for g in glyphs]


def _merge(boxes: list[tuple[float, float, float, float]],
           ) -> list[tuple[float, float, float, float]]:
    """Fusionne les rectangles identiques ou inclus (rendu plus rapide)."""
    out: list[tuple[float, float, float, float]] = []
    for box in sorted(boxes, key=_area, reverse=True):
        if any(_intersect(box, kept) is not None
               and _area(_intersect(box, kept)) >= _area(box) * 0.99
               for kept in out):
            continue
        out.append(box)
    return out


def build_index(doc: Document, exercises: Iterable[Block],
                solutions: Iterable[Block]) -> RegionIndex:
    """Indexe toutes les zones rendues d'une matière."""
    index = RegionIndex(doc)
    for block in exercises:
        index.add_block(block)
        for part in block.parts:
            index.add(part.answer)
    for block in solutions:
        index.add_block(block)
    return index

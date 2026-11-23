"""Découpage des exercices : titre, énoncé, sous-questions.

Le module s'appuie uniquement sur la position du texte et des figures. Il est
utilisé pour les exercices (« Exercice 1.3 ») comme pour les solutions
(« Solution 1.3 ») : la mise en page est la même, seuls les titres changent.

Vocabulaire :
- *rangée* : lignes de texte à la même hauteur (voir pdf_layout.Row) ;
- *marqueur* : début d'une sous-question (« a) », « (b) », « 1. ») ;
- *bloc* : un exercice ou une solution, avec son énoncé et ses sous-questions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional, Sequence

from pdf_layout import (
    Document, Line, PageLayout, Row, Span, is_extension_span,
    MAX_RIGHT, MARGIN, rect_intersects,
)

# --- motifs ---------------------------------------------------------------

TITLE_RE = re.compile(r"^(Exercice|Solution)\s+(\d+\.\d+)\b")
SECTION_RE = re.compile(r"^(\d+)\.(\d+)\b")
# « a) », « (b) », « c ) » : lettre entre parenthèses ou suivie d'une parenthèse.
LETTER_MARKER_RE = re.compile(
    r"^(?:\(\s*([A-Za-z])\s*\)|([A-Za-z])\s*\)|([A-Za-z])\.\s)")
# « 1. », « 2. » : utilisé par quelques exercices de géométrie.
NUMBER_MARKER_RE = re.compile(r"^(\d{1,2})\.(?:\s|$)")

# Au-delà de cet écart, une figure est considérée comme débordante.
MAX_FIGURE_OVERFLOW = 6.0
# Une page est « pleine » (le bloc continue) au-delà de cette hauteur.
FULL_PAGE_Y = 600.0


@dataclass(frozen=True)
class Zone:
    """Rectangle d'une région (énoncé, sous-question, réponse, solution).

    `claims` liste les *spans* de texte qui appartiennent à la région : c'est
    l'autorité de propriété utilisée au rendu pour blanchir tout ce qui, dans
    le rectangle, appartient à une autre région. La propriété est résolue par
    glyphe (origine et abscisse) et non par ligne : un radical CMEX partage sa
    ligne avec son indice, et cette ligne appartient entièrement à la formule
    qu'il surmonte. `lines` mémorise les lignes touchées (une ligne à cheval sur
    deux régions ne doit pas être blanchie pour autant) et `figures` les dessins
    ou images rattachés (ils ne sont jamais blanchis).
    """

    page: int
    rect: tuple[float, float, float, float]
    page_height: float = 0.0
    role: str = "statement"
    group: str = ""
    claims: frozenset = frozenset()
    figures: tuple = ()
    lines: frozenset = frozenset()


@dataclass
class Flag:
    code: str
    message: str


@dataclass
class Part:
    label: str
    question: Optional[Zone] = None
    answer: Optional[Zone] = None
    extra_question: list[Zone] = field(default_factory=list)


@dataclass
class Block:
    """Un exercice ou une solution découpé en zones."""

    kind: str                     # "exercise" | "solution"
    number: str
    page: int                     # page (1-based) du titre
    title_row: Row
    title: Optional[str] = None
    statement: list[Zone] = field(default_factory=list)
    parts: list[Part] = field(default_factory=list)
    pages: list[int] = field(default_factory=list)
    flags: list[Flag] = field(default_factory=list)
    section: Optional[str] = None
    # Figures (dessins pleins, images) rattachées à l'énoncé, par page : une
    # figure qui chevauche l'énoncé lui appartient entièrement et ne doit pas
    # être réclamée par une sous-question, même si celle-ci commence plus haut.
    statement_figures: dict[int, tuple] = field(default_factory=dict)

    @property
    def group(self) -> str:
        """Identifiant du bloc, partagé par toutes ses zones."""
        return f"{self.kind}-{self.number}"


    def flag(self, code: str, message: str) -> None:
        if not any(f.code == code for f in self.flags):
            self.flags.append(Flag(code, message))


@dataclass
class Marker:
    label: str
    page: int
    line: Line
    column: int = 0

    @property
    def x0(self) -> float:
        return self.line.x0

    @property
    def x1(self) -> float:
        return self.line.x1

    @property
    def y0(self) -> float:
        return self.line.y0

    @property
    def y1(self) -> float:
        return self.line.y1

    @property
    def baseline(self) -> float:
        """Ligne de base de l'étiquette : la référence pour lire la colonne."""
        return self.line.origin_y


# --- index du document ----------------------------------------------------

class TitleIndex:
    """Repère titres d'exercices, titres de solutions et titres de sections."""

    def __init__(self, doc: Document):
        self.doc = doc
        self.exercises: dict[int, list[tuple[str, Row]]] = {}
        self.solutions: dict[int, list[tuple[str, Row]]] = {}
        self.section_rows: dict[int, list[Row]] = {}
        self.sections: list[dict] = []
        self.solutions_page: Optional[int] = None
        self._scan()

    # -- balayage ---------------------------------------------------------
    def _scan(self) -> None:
        for index in range(self.doc.page_count):
            page = self.doc.page(index)
            for row in page.rows:
                text = row.text.strip()
                if not text:
                    continue
                found = TITLE_RE.match(text)
                if found:
                    kind, number = found.group(1), found.group(2)
                    bucket = (self.exercises if kind == "Exercice"
                              else self.solutions)
                    bucket.setdefault(page.number, []).append((number, row))
                    continue
                if self.is_heading(row):
                    self.section_rows.setdefault(page.number, []).append(row)

        for page_number in self.exercises:
            self.exercises[page_number].sort(key=lambda item: item[1].y0)
        for page_number in self.solutions:
            self.solutions[page_number].sort(key=lambda item: item[1].y0)
        for page_number in self.section_rows:
            self.section_rows[page_number].sort(key=lambda row: row.y0)

        if self.solutions:
            self.solutions_page = min(self.solutions)
        self.sections = self._build_sections()

    @staticmethod
    def is_heading(row: Row) -> bool:
        """Titre de section, de chapitre, « Exercices » ou « Solutions »."""
        text = row.text.strip()
        if not text or len(text) > 90:
            return False
        lines = [line for line in row.lines if line.text.strip()]
        if not lines or not all(line.bold for line in lines):
            return False
        if text == "Solutions" and lines[0].height > 14:
            return True
        if text == "Exercices" and row.x0 < 90:
            return True
        if row.x0 < 90 and SECTION_RE.match(text):
            return True
        return row.x0 < 90 and max(line.size for line in lines) > 14

    def _build_sections(self) -> list[dict]:
        """Sections numérotées (chapitre.section) d'après la table des matières."""
        sections: list[dict] = []
        chapter = 0
        section = 0
        for level, title, page in self.doc.toc():
            if level == 1:
                if title.lower().startswith("solution"):
                    break
                chapter += 1
                section = 0
            elif level == 2 and chapter:
                section += 1
                sections.append({"id": f"{chapter}.{section}",
                                 "title": title, "page": page})
        # Position imprimée du titre de section, quand on la trouve.
        by_id = {s["id"]: s for s in sections}
        for page_number, rows in self.section_rows.items():
            for row in rows:
                found = SECTION_RE.match(row.text.strip())
                if not found:
                    continue
                sid = f"{int(found.group(1))}.{int(found.group(2))}"
                section = by_id.get(sid)
                if section is not None and "y" not in section \
                        and section["page"] == page_number:
                    section["y"] = row.y0
        return sections

    # -- requêtes ---------------------------------------------------------
    def next_exercise(self, page: int, y: float) -> Optional[tuple[str, Row]]:
        for number, row in self.exercises.get(page, []):
            if row.y0 > y + 1:
                return number, row
        return None

    def next_solution(self, page: int, y: float) -> Optional[tuple[str, Row]]:
        for number, row in self.solutions.get(page, []):
            if row.y0 > y + 1:
                return number, row
        return None

    def heading_after(self, page: int, y: float) -> Optional[Row]:
        for row in self.section_rows.get(page, []):
            if row.y0 > y + 1:
                return row
        return None

    def section_for(self, page: int, y: float) -> Optional[str]:
        best = None
        for section in self.sections:
            start_page = section["page"]
            if start_page < page:
                best = section
            elif start_page == page:
                start_y = section.get("y")
                if start_y is None or start_y <= y:
                    best = section
        return best["id"] if best else None


# --- extraction du titre --------------------------------------------------

def block_title(row: Row, reference: Optional[str] = None) -> Optional[str]:
    """Titre imprimé à droite de « Exercice N.M » / « Solution N.M ».

    En physique : « Exercice 1.3   Le prix d'un bain ». En géométrie, la suite
    de « Solution 1.1 » est parfois la réponse elle-même : on exige alors que
    le texte soit identique au titre de l'exercice correspondant.
    """
    marker = None
    for line in row.lines:
        found = TITLE_RE.match(line.text.strip())
        if found:
            marker = line
            break
    if marker is None:
        return None

    others = [l for l in row.lines if l is not marker and l.x0 > marker.x1 - 2]
    if len(others) != 1:
        return None
    candidate = others[0]
    gap = candidate.x0 - marker.x1
    if not (100.0 <= candidate.x0 <= 230.0 and -2.0 <= gap <= 45.0):
        return None
    title = candidate.text.strip()
    if not title:
        return None
    if reference is None:
        return title
    return title if _same_title(title, reference) else None


def _same_title(a: str, b: str) -> bool:
    def norm(text: str) -> str:
        text = text.replace("’", "'").replace("–", "-").replace("—", "-")
        return re.sub(r"\s+", " ", text).strip().lower()
    return norm(a) == norm(b)


# --- marqueurs de sous-questions -----------------------------------------

def find_markers(page: PageLayout, y0: float, y1: float) -> list[Marker]:
    """Marqueurs de sous-question compris entre y0 et y1 (bornes incluses)."""
    found: list[Marker] = []
    for line in page.body:
        if line.y0 < y0 - 2 or line.y0 > y1:
            continue
        text = line.text.strip()
        if not text:
            continue
        match = LETTER_MARKER_RE.match(text)
        if match:
            label = (match.group(1) or match.group(2)
                     or match.group(3)).lower()
            found.append(Marker(label, page.number, line))
            continue
        match = NUMBER_MARKER_RE.match(text)
        if match:
            found.append(Marker(match.group(1), page.number, line))
    found.sort(key=lambda m: (round(m.y0, 1), m.x0))
    return found


def keep_relevant_markers(markers: list[Marker]) -> list[Marker]:
    """Écarte les « 1. » isolés, qui sont presque toujours du texte courant."""
    letters = [m for m in markers if not m.label.isdigit()]
    if letters:
        return letters
    numbers = [m for m in markers if m.label.isdigit()]
    if len(numbers) < 2:
        return []
    ordered = sorted(numbers, key=lambda m: int(m.label))
    if [m.label for m in ordered] != [str(i) for i in range(1, len(numbers) + 1)]:
        return []
    return numbers


def assign_columns(markers: list[Marker], tolerance: float = 15.0) -> list[Marker]:
    """Range les marqueurs en colonnes d'après leur abscisse."""
    if not markers:
        return markers
    xs = sorted(m.x0 for m in markers)
    clusters: list[list[float]] = [[xs[0]]]
    for x in xs[1:]:
        if x - clusters[-1][-1] <= tolerance:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    centers = [sum(c) / len(c) for c in clusters]
    return [
        Marker(m.label, m.page, m.line,
               min(range(len(centers)), key=lambda i: abs(centers[i] - m.x0)))
        for m in markers
    ]


def label_key(label: str) -> tuple[int, str]:
    if label.isdigit():
        return (int(label), "")
    return (0, label)


# Marge au-dessus du premier marqueur d'une colonne : un numérateur de fraction
# posé au-dessus de la ligne du marqueur appartient encore à cette sous-question.
FIRST_MARKER_REACH = 12.0
# Marge sous le marqueur suivant : une ligne qui ne la dépasse pas en restant
# au-dessus de la rangée suivante revient à la rangée du dessus.
NEXT_ROW_CLEARANCE = 1.5
# Chevauchement vertical (pt) à partir duquel un glyphe fait partie du même bloc
# formule que la ligne d'un marqueur (numérateur au-dessus, dénominateur en
# dessous, grande accolade) : il reste alors à ce marqueur.
FORMULA_OVERLAP = 1.0
# Écart maximal (pt) entre une extension et le span de base qu'elle accompagne.
EXTENSION_REACH = 8.0
# Tolérance verticale (pt) pour reconnaître ce span de base : l'encre d'un
# radical frôle celle de son radicand sans toujours la chevaucher.
EXTENSION_BASE_TOLERANCE = 3.0
# Repli pour une extension sans voisin immédiat : distance verticale maximale
# (pt) à la rangée à laquelle on la rattache.
EXTENSION_FALLBACK = 22.0


def _row_owner(item, members: Sequence[Marker], centers: Sequence[float],
               use_top: bool = False) -> Optional[int]:
    """Indice du marqueur propriétaire d'une figure.

    Les figures sont de gros objets : on garde la règle historique de la
    majorité de la hauteur, qui suffit à les placer dans la bonne sous-question.
    """
    center = (item.y0 + item.y1) / 2
    limit = item.y0 if use_top else item.y1
    owner: Optional[int] = None
    for index, marker in enumerate(members):
        reach = FIRST_MARKER_REACH if index == 0 else 0.0
        if marker.y0 <= center + reach:
            owner = index
    if owner is None:
        return None
    nxt = owner + 1
    if nxt < len(members) and limit > members[nxt].y0 - NEXT_ROW_CLEARANCE:
        middle = (centers[owner] + centers[nxt]) / 2
        return nxt if center >= middle else owner
    return owner


def _vertical_overlap(a: Sequence[float], b: Sequence[float],
                      margin: float = FORMULA_OVERLAP) -> bool:
    """Vrai si deux bbox se chevauchent verticalement au-delà de la marge."""
    return a[1] < b[3] - margin and a[3] > b[1] + margin


def _line_main_baseline(line: Line) -> float:
    """Ligne de base des glyphes de corps de la ligne.

    Les exposants et indices (petits spans) ont une origine décalée : prendre le
    maximum de toutes les origines donnerait leur ligne de base, pas celle de la
    formule. On ne garde donc que les glyphes de taille pleine.
    """
    main = [span for span in line.spans
            if span.text.strip() and span.size >= 0.8 * line.size]
    if main:
        return max(span.origin[1] for span in main)
    return line.origin_y


def _small_base(span: Span, line: Line) -> Optional[Span]:
    """Glyphe de corps dont un exposant/indice est le voisin immédiat."""
    best: Optional[tuple[tuple[float, float], Span]] = None
    for other in line.spans:
        if other is span or not other.text.strip():
            continue
        if other.size < 0.8 * line.size:
            continue
        gap = max(span.bbox[0] - other.bbox[2], other.bbox[0] - span.bbox[2],
                  0.0)
        score = (gap, abs(other.origin[1] - span.origin[1]))
        if best is None or score < best[0]:
            best = (score, other)
    return best[1] if best is not None else None


def _anchor(span: Span, spans: Sequence[Span],
            line: Optional[Line] = None) -> tuple[float, tuple]:
    """Rangée à laquelle rattacher un span : (ligne de base, bbox de référence).

    Un glyphe ordinaire se lit à sa propre origine. Un exposant ou un indice
    (glyphe de petite taille sur une ligne de corps plus grand) est posé
    au-dessus ou au-dessous de la ligne de base : son origine ne doit pas le
    faire glisser vers la région voisine, il suit le glyphe de corps dont il est
    le voisin immédiat (puis la ligne de base de sa ligne). Un glyphe
    d'extension (radical, grande accolade, barre) est dessiné bien au-dessus de
    sa formule et son origine ne dit rien : il suit le span de base qu'il
    accompagne, c'est-à-dire le premier glyphe posé à sa droite sur la même
    bande.
    """
    if not is_extension_span(span):
        if line is not None and span.size < 0.8 * line.size:
            base = _small_base(span, line)
            if base is not None:
                return _anchor(base, spans, line)
            return _line_main_baseline(line), span.ink_box
        return span.baseline, span.ink_box
    best: Optional[tuple[tuple[float, float], Span]] = None
    for other in spans:
        if other is span or not other.text.strip():
            continue
        if is_extension_span(other):
            continue
        gap = other.x0 - span.x1
        if gap < -1.0 or gap > EXTENSION_REACH:
            continue
        if not _vertical_overlap(span.ink_box, other.ink_box,
                                 margin=-EXTENSION_BASE_TOLERANCE):
            continue
        # l'adjacence est déjà filtrée : à moins d'un demi-point près, c'est la
        # distance verticale qui départage (le glyphe de la même rangée)
        score = (round(abs(gap) / 2.0), abs(other.baseline - span.baseline))
        if best is None or score < best[0]:
            best = (score, other)
    base = best[1] if best is not None else None
    if base is None:
        return span.baseline, span.ink_box
    # l'extension suit sa base : c'est la rangée du glyphe qu'elle surmonte qui
    # décide de son propriétaire, pas sa propre bbox (décalée d'une hauteur
    # d'œil vers le haut dans les polices Computer Modern)
    return base.baseline, base.ink_box


def _marker_band(marker: Marker) -> tuple[float, float, float, float]:
    """Bande verticale de la ligne de base d'un marqueur.

    La bbox d'une ligne peut être gonflée par un exposant, une pièce de fraction
    ou une grande accolade de la ligne précédente ; l'exception « bloc formule »
    ne doit se déclencher que sur l'encre de la ligne de base du marqueur.
    """
    line = marker.line
    size = line.size or 12.0
    return (line.x0, marker.baseline - 0.6 * size,
            line.x1, marker.baseline + 0.6 * size)


def _span_owner(anchor_y: float, bbox: Sequence[float],
                members: Sequence[Marker]) -> Optional[int]:
    """Indice du marqueur propriétaire d'un glyphe, d'après sa ligne de base.

    - le propriétaire est le dernier marqueur de la colonne dont la ligne de
      base est au-dessus de celle du glyphe (marge au-dessus du premier) ;
    - exception « bloc formule » : un glyphe qui chevauche verticalement la
      bande de la ligne de base du marqueur *suivant* (numérateur posé
      au-dessus de son « = », grande accolade) appartient à ce marqueur ;
    - une ligne sans marqueur reste donc au dernier marqueur ouvert au-dessus
      d'elle (réponse sur deux lignes), sans jamais glisser à la suivante.
    """
    owner: Optional[int] = None
    for index, marker in enumerate(members):
        reach = FIRST_MARKER_REACH if index == 0 else 0.0
        if marker.baseline <= anchor_y + reach:
            owner = index
    if owner is None:
        return None
    nxt = owner + 1
    if nxt < len(members) and _vertical_overlap(bbox,
                                                _marker_band(members[nxt])):
        return nxt
    return owner


def _extension_fallback(span: Span, members: Sequence[Marker]) -> Optional[int]:
    """Rattache une extension à la rangée dont l'encre est la plus proche.

    Deux cas : une extension restée sans propriétaire (grande accolade ouverte
    au-dessus du premier marqueur d'une colonne) et une pièce de délimiteur qui
    ne touche pas la rangée trouvée par sa base (pièce haute d'une grande
    parenthèse, accolade à cheval sur plusieurs lignes).
    """
    box = span.ink_box
    cy = (box[1] + box[3]) / 2
    best: Optional[int] = None
    best_dist = EXTENSION_FALLBACK
    for index, marker in enumerate(members):
        line = marker.line
        dist = max(line.y0 - cy, 0.0, cy - line.y1)
        if dist < best_dist:
            best, best_dist = index, dist
    return best


# --- construction d'un bloc ----------------------------------------------

class BlockBuilder:
    """Construit l'énoncé et les sous-questions d'un exercice ou d'une solution."""

    def __init__(self, doc: Document, index: TitleIndex):
        self.doc = doc
        self.index = index

    # -- utilitaires ------------------------------------------------------
    def _page(self, number: int) -> PageLayout:
        return self.doc.page(number - 1)

    def _region_end(self, page: PageLayout, y: float, kind: str) -> tuple[float, bool]:
        """Fin de la zone du bloc sur cette page, et présence d'un titre après."""
        nxt = (self.index.next_exercise(page.number, y) if kind == "exercise"
               else self.index.next_solution(page.number, y))
        candidates = [nxt[1].y0] if nxt else []
        heading = self.index.heading_after(page.number, y)
        if heading is not None:
            candidates.append(heading.y0)
        if candidates:
            return min(candidates) - 2.0, True
        return page.content_bottom + 2.0, False

    def _continuation(self, page: PageLayout, kind: str) -> Optional[PageLayout]:
        """Page suivante si le bloc s'y poursuit, sinon None."""
        number = page.number + 1
        if number > self.doc.page_count:
            return None
        if kind == "exercise" and self.index.solutions_page is not None \
                and number >= self.index.solutions_page:
            return None
        candidate = self._page(number)
        titles = (self.index.exercises if kind == "exercise"
                  else self.index.solutions)
        first = titles.get(number)
        top_limit = first[0][1].y0 - 2 if first else candidate.height
        rows = [r for r in candidate.rows if r.y0 < top_limit]
        if not rows:
            return None
        # un titre de section ou de chapitre en haut de page = pas une suite
        if any(self.index.is_heading(r) for r in rows):
            return None
        return candidate

    def _figure_union(self, page: PageLayout, rect: Sequence[float],
                      limits: Sequence[float],
                      exclude: Sequence[Sequence[float]] = ()
                      ) -> tuple[list[float], bool]:
        """Agrandit une zone pour englober les figures qu'elle chevauche.

        Seules les figures dont le *centre* tombe dans la bande de la région
        sont englobées : le tracé de fond d'un graphique pleine page (dont la
        bbox couvre la page entière) ne doit pas étirer une découpe d'une ligne
        jusqu'au bas de la page. `exclude` écarte les figures déjà rattachées à
        une autre région (celles de l'énoncé, jamais découpées par une
        sous-question).
        """
        result = list(rect)
        overflow = False
        skip = {tuple(round(float(v), 3) for v in f) for f in exclude}
        for figure in page.figures():
            if tuple(round(float(v), 3) for v in figure.bbox) in skip:
                continue
            if not rect_intersects(figure.bbox, result):
                continue
            cx, cy = figure.center
            if not (limits[0] <= cx <= limits[2] and limits[1] <= cy <= limits[3]):
                continue
            grow = [
                max(min(result[0], max(figure.x0 - 2, 6)), limits[0]),
                max(min(result[1], max(figure.y0 - 2, 6)), limits[1]),
                max(result[2], min(figure.x1 + 2, limits[2])),
                max(result[3], min(figure.y1 + 2, limits[3])),
            ]
            if (grow[0] < rect[0] - MAX_FIGURE_OVERFLOW
                    or grow[1] < rect[1] - MAX_FIGURE_OVERFLOW
                    or grow[2] > rect[2] + MAX_FIGURE_OVERFLOW
                    or grow[3] > rect[3] + MAX_FIGURE_OVERFLOW):
                overflow = True
            result = grow
        return result, overflow

    def _content_bottom(self, page: PageLayout, y0: float, y1: float,
                        x0: float, x1: float, clamp: bool = True) -> float:
        """Bas réel du contenu (texte et figures) dans une bande."""
        bottom = y0
        for line in page.body:
            if line.y1 < y0 or line.y0 > y1:
                continue
            if line.x1 < x0 or line.x0 > x1:
                continue
            bottom = max(bottom, line.y1)
        for figure in page.figures():
            if figure.y1 < y0 or figure.y0 > y1:
                continue
            if figure.x1 < x0 or figure.x0 > x1:
                continue
            bottom = max(bottom, figure.y1)
        return min(bottom, y1) if clamp else bottom

    def _content_right(self, page: PageLayout, y0: float, y1: float) -> float:
        right = 0.0
        for line in page.body:
            if line.y0 >= y0 - 1 and line.y1 <= y1 + 1:
                right = max(right, line.x1)
        for figure in page.figures():
            if figure.y0 >= y0 - 1 and figure.y1 <= y1 + 1:
                right = max(right, figure.x1)
        return right

    def _content_above(self, page: PageLayout, y: float,
                       x0: float, x1: float) -> float:
        """Bas du dernier contenu situé au-dessus de y (même bande x)."""
        bottom = 0.0
        for line in page.body:
            if line.y1 <= y + 0.5 and line.x1 >= x0 and line.x0 <= x1:
                bottom = max(bottom, line.y1)
        for figure in page.figures():
            if figure.y1 <= y + 0.5 and figure.x1 >= x0 and figure.x0 <= x1:
                bottom = max(bottom, figure.y1)
        return bottom

    # -- construction -----------------------------------------------------
    def build(self, kind: str, number: str, title_row: Row,
              title: Optional[str] = None,
              reference_title: Optional[str] = None) -> Block:
        page = self._page(title_row.page)
        block = Block(kind=kind, number=number, page=page.number,
                      title_row=title_row,
                      title=title if title is not None
                      else block_title(title_row, reference_title))

        bounds: dict[int, tuple[float, float]] = {}
        markers: list[Marker] = []
        current = page
        top = title_row.y0 - MARGIN
        for depth in range(3):  # 3 pages maximum pour un même bloc
            probe = title_row.y0 if depth == 0 else -1.0
            end, following = self._region_end(current, probe, kind)
            bounds[current.number] = (top, end)
            markers += find_markers(current, max(top - 2, 0), end)
            if following:
                break
            bottom = self._content_bottom(current, top, end, 0, current.width)
            if bottom < FULL_PAGE_Y:
                break
            nxt = self._continuation(current, kind)
            if nxt is None:
                break
            current = nxt
            top = 0.0

        markers = assign_columns(keep_relevant_markers(markers))
        # un marqueur situé dans la rangée du titre fait partie du titre
        # (« Solution 1.41 … b) … » sur une seule ligne)
        markers = [m for m in markers
                   if m.page != page.number or m.y0 >= title_row.y1 - 1]
        block.pages = sorted(bounds)

        # Une figure qui chevauche l'énoncé lui appartient entièrement : elle
        # est réclamée avant les sous-questions, pour qu'aucune d'elles ne la
        # découpe (physique 2.30 : le schéma du cable est à droite de l'énoncé
        # alors que les questions commencent plus haut à gauche).
        statement_figures = self._statement_figures(block, bounds, markers)
        block.statement_figures = statement_figures

        column_start, block_right = self._columns(block, bounds, markers)
        spans = self._part_spans(block, bounds, markers,
                                 column_start, block_right, statement_figures)
        self._build_statement(block, bounds, markers, spans,
                              statement_figures)
        self._build_parts(block, bounds, markers,
                          column_start, block_right, spans, statement_figures)

        if not block.statement:
            # filet de sécurité : la zone du titre seule
            rect = page.clamp_to_body(
                (title_row.x0 - MARGIN,
                 title_row.y0 - MARGIN,
                 page.content_right,
                 title_row.y1 + MARGIN))
            block.statement.append(Zone(
                page.number,
                tuple(round(v, 1) for v in rect),
                page.height, "statement", block.group,
                frozenset().union(*(line.span_keys for line in title_row.lines)),
                (),
                frozenset(line.key for line in title_row.lines)))

        if len(block.pages) > 1:
            block.flag(
                "split_pages",
                f"{'exercice' if kind == 'exercise' else 'solution'} coupé sur "
                f"2 pages (p. {block.pages[0]} → {block.pages[1]})")
        return block

    def _statement_figures(self, block: Block,
                           bounds: dict[int, tuple[float, float]],
                           markers: list[Marker]) -> dict[int, tuple]:
        """Figures qui chevauchent une bande d'énoncé (par page).

        Une figure (dessin pleine largeur, image bitmap) posée à côté du texte
        d'énoncé lui appartient : elle est conservée en entier dans l'énoncé et
        retirée des sous-questions, même si celles-ci commencent plus haut à
        gauche. Le test est volontairement géométrique : chevauchement avec la
        bande de texte de l'énoncé (du titre au premier marqueur) et centre
        horizontal dans la colonne de l'énoncé.
        """
        out: dict[int, tuple] = {}
        for number in sorted(bounds):
            page = self._page(number)
            top, end = bounds[number]
            if number != block.page:
                rows = [r for r in page.rows if r.y0 < end]
                if not rows:
                    continue
                top = rows[0].y0
            limit = end
            tops = [m.y0 for m in markers if m.page == number]
            if tops:
                limit = min(limit, min(tops) - 0.8)
                if number == block.page:
                    limit = max(limit, block.title_row.y1 + 2)
            if limit <= top:
                continue
            text = [line for line in page.body
                    if line.text.strip() and line.y1 > top and line.y0 < limit]
            if not text:
                continue
            left = min(line.x0 for line in text)
            right = max(max(line.x1 for line in text), page.content_right)
            band = (left - 30.0, top, right + 30.0, limit)
            figures = [
                figure.bbox for figure in page.figures()
                if rect_intersects(figure.bbox, band)
                and band[0] <= figure.center[0] <= band[2]
                # le tracé commence dans la bande de l'énoncé (pas au-dessus,
                # dans le bloc précédent) et ne traverse pas le titre suivant :
                # une bbox qui déborde ainsi est celle d'un tracé de fond, pas
                # d'une figure de l'énoncé
                and figure.y0 >= top - 20.0
                and figure.y1 <= end + 2.0
            ]
            if figures:
                out[number] = tuple(figures)
        return out

    def _build_statement(self, block: Block,
                         bounds: dict[int, tuple[float, float]],
                         markers: list[Marker],
                         spans: dict[int, tuple[float, float, float, ...]],
                         statement_figures: dict[int, tuple] | None = None
                         ) -> None:
        group = block.group
        statement_figures = statement_figures or {}
        for number in sorted(bounds):
            page = self._page(number)
            top, end = bounds[number]
            if number != block.page:
                rows = [r for r in page.rows if r.y0 < end]
                if not rows:
                    continue
                top = rows[0].y0
            limit = end
            tops = [spans[id(m)][0] for m in markers if m.page == number]
            if tops:
                limit = min(limit, min(tops) - 0.8)
                if number == block.page:
                    # le titre fait toujours partie de l'énoncé
                    limit = max(limit, block.title_row.y1 + 2)
            if limit <= top:
                continue
            bottom = self._content_bottom(page, top, limit, 0, page.width)
            if bottom <= top:
                continue
            left = (block.title_row.x0 if number == block.page
                    else page.content_left)
            rect = [left, top, page.content_right, bottom]
            rect, overflow = self._figure_union(
                page, rect, (0, top - 20, page.width, limit))
            # une figure qui chevauche l'énoncé est gardée en entier : on étend
            # le cadre jusqu'à son bas, même au-delà du premier marqueur
            own_figures = statement_figures.get(number, ())
            for figure in own_figures:
                rect[0] = min(rect[0], max(figure[0] - 2, 0.0))
                rect[1] = min(rect[1], max(figure[1] - 2, top - 20))
                rect[2] = max(rect[2], min(figure[2] + 2, page.width))
                rect[3] = max(rect[3], min(figure[3] + 2, end))
            figures = self._claimed_figures(page, rect)
            for figure in own_figures:
                if figure not in figures:
                    figures.append(figure)
            if overflow:
                block.flag("figure_overflow",
                           f"une figure dépasse le cadre de l'énoncé (p. {number})")
            rect = self._pad(page, rect, above=top, below=max(limit, rect[3]))
            if rect[3] - rect[1] < 10 and block.statement:
                # morceau réduit à un fragment de formule : sans intérêt
                continue
            claims, lines = self._statement_claims(
                page, top, limit,
                block.title_row if number == block.page else None,
                figures)
            rect = page.clamp_to_body(rect)
            if rect[3] <= rect[1]:
                continue
            block.statement.append(
                Zone(number, tuple(round(v, 1) for v in rect), page.height,
                     "statement", group, claims, tuple(figures), lines))

    def _statement_claims(self, page: PageLayout, top: float,
                          limit: float,
                          title_row: Optional[Row] = None,
                          figures: Sequence[Sequence[float]] = ()
                          ) -> tuple[frozenset, frozenset]:
        """Glyphes de l'énoncé : ceux qui occupent la bande, pleine largeur.

        La revendication est volontairement large (tout glyphe qui mord sur la
        bande) : un énoncé ne doit jamais perdre un morceau de formule parce
        qu'une sous-question commence au même niveau. Les glyphes revendiqués
        ici restent visibles dans les autres régions si celles-ci les
        revendiquent aussi.

        `figures` : figures rattachées à l'énoncé. Leurs étiquettes (cotes
        « 4 », « x », légendes) sont posées à côté du dessin, parfois au-delà
        de la bande de texte (sous le premier marqueur) : elles appartiennent à
        l'énoncé et ne doivent jamais être prises pour du contenu étranger
        (algèbre 7.101, physique 2.30). On revendique donc toute ligne dont le
        centre tombe dans l'enveloppe des figures, élargie de 8 pt.
        """
        claims: set[tuple] = set()
        lines: set[tuple] = set()
        for line in page.body:
            if line.y1 > top and line.y0 < limit:
                lines.add(line.key)
                claims |= line.span_keys
        if title_row is not None:
            for line in title_row.lines:
                lines.add(line.key)
                claims |= line.span_keys
        if figures:
            pad = 8.0
            x0 = min(f[0] for f in figures) - pad
            y0 = min(f[1] for f in figures) - pad
            x1 = max(f[2] for f in figures) + pad
            y1 = max(f[3] for f in figures) + pad
            for line in page.body:
                if not line.text.strip():
                    continue
                centre = ((line.x0 + line.x1) / 2, (line.y0 + line.y1) / 2)
                if x0 <= centre[0] <= x1 and y0 <= centre[1] <= y1:
                    lines.add(line.key)
                    claims |= line.span_keys
        return frozenset(claims), frozenset(lines)

    def _claimed_figures(self, page: PageLayout,
                         rect: Sequence[float],
                         exclude: Sequence[Sequence[float]] = ()
                         ) -> list[tuple]:
        """Figures (dessins pleins, images) contenues dans un rectangle."""
        out: list[tuple] = []
        skip = {tuple(round(float(v), 3) for v in f) for f in exclude}
        for figure in page.figures():
            if tuple(round(float(v), 3) for v in figure.bbox) in skip:
                continue
            center = ((figure.x0 + figure.x1) / 2, (figure.y0 + figure.y1) / 2)
            if not (rect[0] <= center[0] <= rect[2]
                    and rect[1] <= center[1] <= rect[3]):
                continue
            out.append(figure.bbox)
        return out

    def _pad(self, page: PageLayout, rect: Sequence[float], above: float,
             below: float, keep: Sequence[float] | None = None) -> list[float]:
        """Ajoute la marge de 4 pt sans déborder sur le voisin.

        `keep` est l'étendue du *texte* revendiqué (haut, bas) : elle n'est
        jamais rognée, même si le voisin est proche. Les figures, elles, sont
        bornées par `below` : un graphique pleine page ne doit pas étirer la
        découpe jusqu'au bas de la page.
        """
        x0, y0, x1, y1 = rect
        keep_top, keep_bottom = (keep if keep is not None else (y0, y1))
        previous = self._content_above(page, above, 0, page.width)
        top = min(y0, max(y0 - MARGIN, previous + 0.8), keep_top)
        # le contenu propre de la zone n'est jamais rogné : mieux vaut 2 pt de
        # marge en moins qu'un dénominateur tronqué
        bottom = max(keep_bottom, min(y1 + MARGIN, below))
        return [
            max(x0 - MARGIN, 0.0),
            max(top, 0.0),
            min(x1 + MARGIN, page.width),
            min(bottom, page.height),
        ]

    def _columns(self, block: Block, bounds: dict[int, tuple[float, float]],
                 markers: list[Marker]) -> tuple[dict[int, float], float]:
        """Début de chaque colonne et marge droite du bloc."""
        if not markers:
            return {}, 0.0
        column_start: dict[int, float] = {}
        for marker in markers:
            column_start[marker.column] = min(
                column_start.get(marker.column, marker.x0), marker.x0)
        parts_top = min(m.y0 for m in markers)
        block_right = 0.0
        for number in block.pages:
            page = self._page(number)
            start = parts_top if number == markers[0].page else 0.0
            block_right = max(block_right,
                              self._content_right(page, start, bounds[number][1]))
        return column_start, min(MAX_RIGHT, max(block_right + 4.0, 120.0))

    @staticmethod
    def _page_columns(markers: Sequence[Marker]) -> dict[int, dict[int, float]]:
        """Début de chaque colonne, page par page.

        Un bloc coupé sur deux pages a des marqueurs légèrement décalés d'une
        page à l'autre : les colonnes doivent se lire page par page, sinon la
        marge droite d'une sous-question se règle sur la colonne d'une autre
        page et coupe la figure de la sienne.
        """
        out: dict[int, dict[int, float]] = {}
        for marker in markers:
            columns = out.setdefault(marker.page, {})
            columns[marker.column] = min(columns.get(marker.column, marker.x0),
                                         marker.x0)
        return out

    def _part_spans(self, block: Block, bounds: dict[int, tuple[float, float]],
                    markers: list[Marker], column_start: dict[int, float],
                    block_right: float,
                    statement_figures: dict[int, tuple] | None = None
                    ) -> dict[int, tuple]:
        """Étendue (haut, bas, droite) et contenu de chaque marqueur.

        Chaque glyphe est attribué individuellement, par son origine (ligne de
        base) et son abscisse, et non par la majorité de la bbox de sa ligne :
        un radical CMEX est posé très haut au-dessus de sa formule, sa bbox
        s'étale sur deux rangées et le vote majoritaire le rendait à la
        sous-question précédente (il était ensuite blanchi dans la bonne).

        - le propriétaire d'un glyphe est le dernier marqueur de la colonne
          dont la ligne de base est au-dessus de la sienne ;
        - une ligne sans marqueur (réponse sur deux lignes, dénominateur d'une
          fraction centrée) reste au dernier marqueur ouvert au-dessus d'elle ;
        - un glyphe qui chevauche verticalement la ligne du marqueur suivant
          (numérateur posé au-dessus de son « = », grande accolade) reste à ce
          marqueur : c'est le même bloc formule ;
        - une extension (radical, accolade) suit le glyphe de base qu'elle
          accompagne à sa droite.

        Le résultat mémorise les clés des spans et des lignes revendiquées,
        ainsi que les figures rattachées : ils servent au blanchiment des
        fragments voisins au moment du rendu.
        """
        spans: dict[int, tuple] = {}
        if not markers:
            return spans
        statement_figures = statement_figures or {}
        groups: dict[tuple[int, int], list[Marker]] = {}
        for marker in markers:
            groups.setdefault((marker.page, marker.column), []).append(marker)

        page_columns = self._page_columns(markers)
        for (page_number, column), members in groups.items():
            page = self._page(page_number)
            end = bounds[page_number][1]
            rights = [x for c, x in page_columns[page_number].items()
                      if c > column]
            x1 = min(rights) - 2 if rights else block_right
            x0 = min(m.x0 for m in members) - 2
            members = sorted(members, key=lambda m: m.y0)
            page_spans = [span for line in page.body for span in line.spans]
            owned: dict[int, list[tuple[Line, Span]]] = {
                i: [] for i in range(len(members))}
            orphans: list[tuple[Line, Span]] = []
            for line in page.body:
                if line.x1 < x0 or line.x0 > x1:
                    continue
                if line.y0 >= end:
                    continue  # au-delà du bloc : exercice ou solution suivant
                for span in line.spans:
                    if not span.text:
                        continue
                    anchor_y, anchor_box = _anchor(span, page_spans, line)
                    owner = _span_owner(anchor_y, anchor_box, members)
                    small = line.size > 0 and span.size < 0.8 * line.size
                    if owner is None:
                        if is_extension_span(span) or small:
                            # formule posée au-dessus du premier marqueur de la
                            # colonne (exposant d'un numérateur) : on la rend à
                            # la rangée dont l'encre est la plus proche
                            orphans.append((line, span))
                        continue
                    if is_extension_span(span) \
                            and not _vertical_overlap(span.ink_box,
                                                      members[owner].line.ink_bbox,
                                                      margin=-FORMULA_OVERLAP):
                        # la rangée trouvée ne touche pas l'encre du glyphe
                        # (pièce haute d'une grande parenthèse, accolade à
                        # cheval sur plusieurs lignes) : on la rend à la rangée
                        # la plus proche verticalement
                        near = _extension_fallback(span, members)
                        if near is not None:
                            owner = near
                    owned[owner].append((line, span))
            for line, span in orphans:
                owner = _extension_fallback(span, members)
                if owner is not None:
                    owned[owner].append((line, span))

            for index, marker in enumerate(members):
                top, bottom, right = marker.y0, marker.y1, marker.x1
                claims: set[tuple] = set()
                lines: set[tuple] = set()
                figures: list[tuple] = []
                statement_boxes = {
                    tuple(round(float(v), 3) for v in f)
                    for f in statement_figures.get(page_number, ())}
                for line, span in owned[index]:
                    claims.add(span.key)
                    lines.add(line.key)
                    box = span.ink_box
                    if index == 0 and box[0] < marker.x0 + 20 \
                            and box[1] < marker.y0:
                        # texte d'énoncé aligné sur le marqueur : il appartient
                        # aussi à l'énoncé, il ne fait pas grandir la zone
                        continue
                    top = min(top, box[1])
                    bottom = max(bottom, box[3])
                    right = max(right, box[2])
                for figure in page.figures():
                    if tuple(round(float(v), 3) for v in figure.bbox) \
                            in statement_boxes:
                        # figure de l'énoncé : aucune sous-question ne la découpe
                        continue
                    if figure.x1 < x0 or figure.x0 > x1:
                        continue
                    if figure.y0 >= end:
                        continue
                    centers = [(m.y0 + m.y1) / 2 for m in members]
                    if _row_owner(figure, members, centers, use_top=True) != index:
                        continue
                    if figure.center[1] > end:
                        # tracé de fond d'un graphique pleine page : il
                        # n'appartient pas à la ligne, son centre est bien plus
                        # bas que la fin du bloc
                        continue
                    # une figure ne fait pas remonter la zone au-dessus du
                    # marqueur (le haut de la figure reste dans l'énoncé) et son
                    # étendue est bornée au bloc : sans cela un graphique pleine
                    # page étirerait la découpe jusqu'au bas de la page
                    figures.append(figure.bbox)
                spans[id(marker)] = (top, bottom, right, frozenset(claims),
                                     tuple(figures), frozenset(lines))
        return spans

    def _build_parts(self, block: Block,
                     bounds: dict[int, tuple[float, float]],
                     markers: list[Marker], column_start: dict[int, float],
                     block_right: float,
                     spans: dict[int, tuple[float, float, float, frozenset, tuple]],
                     statement_figures: dict[int, tuple] | None = None
                     ) -> None:
        if not markers:
            return

        statement_figures = statement_figures or {}
        parts: dict[str, Part] = {}
        page_columns = self._page_columns(markers)
        for marker in markers:
            page = self._page(marker.page)
            end = bounds[marker.page][1]
            statement_boxes = tuple(statement_figures.get(marker.page, ()))
            rights = [x for c, x in page_columns[marker.page].items()
                      if c > marker.column]
            right = min(rights) if rights else block_right
            same = [m for m in markers
                    if m.column == marker.column and m.page == marker.page
                    and (m.y0 + m.y1) / 2 > (marker.y0 + marker.y1) / 2 + 1]
            continues = [m for m in markers
                         if m.column == marker.column and m.page > marker.page]
            top, bottom, content_right, claims, figures, lines = spans[id(marker)]
            if marker.page == block.page:
                # un titre n'appartient jamais à une sous-question
                title_lines = {line.key for line in block.title_row.lines}
                title_spans = set().union(
                    *(line.span_keys for line in block.title_row.lines))
                claims = claims - title_spans
                lines = lines - title_lines
            column_x1 = max(right - 2, content_right + 1)

            # fin de la zone : haut du marqueur suivant de la même colonne
            # (une formule du voisin peut dépasser au-dessus de son marqueur,
            # on préfère alors un fragment du voisin à un texte tronqué)
            if same:
                limit = same[0].y0 - 0.8
            else:
                limit = end

            rect = [marker.x0, top, column_x1, bottom]
            # une figure rattachée à la sous-question étend le cadre jusqu'à
            # elle, sans jamais dépasser la sous-question suivante ni la fin du
            # bloc (un tracé de fond pleine page ne peut plus étirer la découpe)
            bound = min(limit + 20, end)
            for figure in figures:
                rect[2] = max(rect[2], min(figure[2] + 2, page.width))
                rect[3] = max(rect[3], min(figure[3] + 2, bound))
            rect, overflow = self._figure_union(
                page, rect, (0, top, page.width, bound),
                exclude=statement_boxes)
            figures = tuple(figures) + tuple(
                f for f in self._claimed_figures(page, rect,
                                                 exclude=statement_boxes)
                if f not in figures)

            if rect[2] > column_x1:
                # une figure dépasse la colonne : le cadre garde la largeur de
                # la figure (ses étiquettes sont du texte revendiqué, donc
                # toujours comprises) et la découpe est signalée
                overflow = True
            if overflow:
                block.flag(
                    "figure_overflow",
                    f"une figure dépasse le cadre de la sous-question "
                    f"{marker.label} (p. {marker.page})")
            rect = self._pad(page, rect, above=top, below=limit,
                             keep=(top, bottom))
            if rights:
                rect[2] = max(min(rect[2], right - 0.5), content_right + 1)
            # un titre (« Exercice N.M », « Solution N.M ») n'apparaît jamais
            # dans une sous-question : le haut du cadre passe sous le titre,
            # sauf si le contenu propre de la sous-question commence au-dessus
            rect[1] = self._below_title(block, marker, page, rect[1], claims)
            rect = list(page.clamp_to_body(rect))
            if rect[3] <= rect[1]:
                continue

            # Resserrement entre lignes de base voisines : le cadre ne garde
            # pas une ligne étrangère entière au-dessus ou au-dessous de son
            # propre contenu (en mode headings, on ne peint pas ces fragments).
            rect = self._trim_to_own_rows(page, rect, claims, lines, figures)
            # Une rangée de tableau / une ligne de figure est une seule entité :
            # si la zone en revendique une cellule, elle revendique la rangée
            # (les autres cellules restent visibles au lieu d'être comptées
            # comme contenu étranger).
            claims, lines = self._row_mates(page, rect, claims, lines)

            part = parts.setdefault(marker.label, Part(label=marker.label))
            zone = Zone(marker.page, tuple(round(v, 1) for v in rect),
                        page.height, "part", block.group, claims, figures, lines)
            if part.question is None:
                part.question = zone
            else:
                part.extra_question.append(zone)
            if continues and not same:
                block.flag(
                    "split_pages",
                    f"sous-question {marker.label} coupée en bas de page "
                    f"(p. {marker.page})")

        block.parts = sorted(parts.values(), key=lambda p: label_key(p.label))

    def _below_title(self, block: Block, marker: Marker, page: PageLayout,
                     top: float, claims) -> float:
        """Ramène le haut d'une sous-question sous le bas de son titre.

        La marge de 4 pt est rognée au besoin ; jamais au point d'amputer le
        contenu propre de la sous-question (une grande accolade peut commencer
        au-dessus de la ligne du titre).
        """
        if marker.page != block.page:
            return top
        title_bottom = block.title_row.y1
        content_top = min((span.ink_box[1] for line in page.body
                           for span in line.spans if span.key in claims),
                          default=top)
        return max(top, min(title_bottom + 1.0, content_top))

    @staticmethod
    def _trim_to_own_rows(page: PageLayout, rect: Sequence[float],
                          claims, lines, figures: Sequence[Sequence[float]]
                          ) -> list[float]:
        """Resserre le cadre entre les lignes de base voisines.

        Si le rectangle dépasse le contenu propre de plus de 2 pt en haut ou en
        bas, une ligne étrangère entière est visible au bord. On ramène alors la
        borne au bord de cette ligne — sans jamais dépasser le contenu propre.
        C'est un resserrement de rectangle, pas un blanchiment : dès que les
        deux contenus se chevauchent verticalement (fraction haute, radical,
        indice), la borne ne bouge pas (un fragment du voisin vaut mieux qu'un
        glyphe coupé).
        """
        own = [span.ink_box for line in page.body if line.key in lines
               for span in line.spans
               if span.key in claims and span.text.strip()]
        if not own:
            return list(rect)
        tops = [box[1] for box in own] + [f[1] for f in figures]
        bottoms = [box[3] for box in own] + [f[3] for f in figures]
        own_top, own_bottom = min(tops), max(bottoms)
        x0, y0, x1, y1 = rect
        body = [line for line in page.body
                if line.key not in lines and line.text.strip()
                and line.x1 > x0 and line.x0 < x1]
        if y0 < own_top - 2.0:
            above = [line.ink_bbox[3] for line in body
                     if line.ink_bbox[3] <= own_top - 0.2
                     and line.ink_bbox[3] > y0]
            if above:
                y0 = min(max(y0, max(above) + 0.4), own_top - 0.6)
        if y1 > own_bottom + 2.0:
            below = [line.ink_bbox[1] for line in body
                     if line.ink_bbox[1] >= own_bottom + 0.2
                     and line.ink_bbox[1] < y1]
            if below:
                y1 = max(min(y1, min(below) - 0.4), own_bottom + 0.6)
        return [x0, y0, x1, y1]

    @staticmethod
    def _row_mates(page: PageLayout, rect: Sequence[float], claims,
                   lines) -> tuple[frozenset, frozenset]:
        """Revendique les autres cellules d'une rangée déjà revendiquée.

        Les tableaux (géométrie 1.78) et les figures posent leurs cellules sur
        des lignes distinctes d'une même rangée : si la zone en revendique une,
        les autres cellules de la même rangée et du même cadre lui appartiennent
        aussi. Cela ne change aucun pixel (rien n'est peint en mode headings),
        cela évite seulement de les compter comme contenu étranger.
        """
        owned = set(lines)
        if not owned:
            return claims, lines
        extra_claims = set(claims)
        extra_lines = set(owned)
        for row in page.rows:
            if not any(line.key in owned for line in row.lines):
                continue
            for line in row.lines:
                if line.key in extra_lines:
                    continue
                box = line.ink_bbox
                if box[2] <= rect[0] or box[0] >= rect[2]:
                    continue
                if box[3] <= rect[1] or box[1] >= rect[3]:
                    continue
                extra_lines.add(line.key)
                extra_claims |= line.span_keys
        return frozenset(extra_claims), frozenset(extra_lines)

"""Tests des régressions trouvées à la relecture (radicaux, exposants, figures).

Trois règles sont vérifiées ici, en plus des tests de fragments :

1. **aucun glyphe propre blanchi** : un radical, son indice, un dénominateur ou
   un exposant de la région ne doivent jamais être recouverts par un rectangle
   blanc (le sens mathématique changerait). `WhitenPlan.own_hits` doit valoir 0
   pour chaque image, et un contrôle indépendant vérifie qu'aucun rectangle
   blanc ne touche la bbox d'un glyphe revendiqué, ni aucune *boîte de ligne
   propre* (protection indépendante de l'attribution : exposants, indices,
   numérateurs, dénominateurs et barres de fraction de la région) ;
2. **réponse sur plusieurs lignes** : une ligne sans marqueur reste à la
   dernière région ouverte au-dessus d'elle (dénominateur d'une fraction),
   sauf si elle forme le même bloc formule que la ligne d'un marqueur ;
3. **figure d'énoncé et réponses vides** : une figure qui chevauche l'énoncé
   lui appartient en entier (physique 2.30), et une réponse réduite à son
   marqueur (ou à un fragment du graphique commun, algèbre 7.19) est publiée
   avec `answer: null`.

Lancer depuis la racine du dépôt :

    extract/.venv/bin/python -m pytest extract/tests -q
"""

from __future__ import annotations

import json
import random
import sys
from functools import lru_cache
from pathlib import Path

import pytest
import pymupdf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "extract"))

from exercises import BlockBuilder, TitleIndex  # noqa: E402
from pdf_layout import Document, is_extension_span  # noqa: E402
from regions import _intersect, build_index, get_whiten_mode  # noqa: E402
from render import crop_clip, ink_pixels, render_crop  # noqa: E402
from solutions import SolutionSet, attach_answers  # noqa: E402

CATALOG_PATH = ROOT / "data" / "catalog.json"


# --- outils ---------------------------------------------------------------

@lru_cache(maxsize=None)
def _subject(subject: str):
    doc = Document(str(ROOT / "pdfs" / f"{subject}.pdf"))
    return doc, TitleIndex(doc)


@lru_cache(maxsize=None)
def _exercise(subject: str, number: str):
    """(Block, solution, RegionIndex) pour un exercice donné."""
    doc, index = _subject(subject)
    row = next(row for page in index.exercises
               for num, row in index.exercises[page] if num == number)
    builder = BlockBuilder(doc, index)
    block = builder.build("exercise", number, row)
    solution = SolutionSet(doc, index, {number: block.title},
                           only={number}).get(number)
    attach_answers(block, solution)
    regions = build_index(doc, [block], [solution] if solution else [])
    return block, solution, regions


@lru_cache(maxsize=None)
def _solution_crops(subject: str, number: str):
    """(doc, solution, zones fusionnées) pour une solution donnée."""
    doc, index = _subject(subject)
    row = next(row for page in index.exercises
               for num, row in index.exercises[page] if num == number)
    block = BlockBuilder(doc, index).build("exercise", number, row)
    solutions = SolutionSet(doc, index, {number: block.title}, only={number})
    solution = solutions.get(number)
    if solution is None:
        pytest.skip(f"solution {subject} {number} absente")
    regions = build_index(doc, [], [solution])
    return doc, solution, solutions.crops(solution), regions


def _contains(outer, inner) -> bool:
    return (outer[0] - 0.01 <= inner[0] and outer[1] - 0.01 <= inner[1]
            and outer[2] + 0.01 >= inner[2] and outer[3] + 0.01 >= inner[3])


def _part(block, label: str):
    return next(part for part in block.parts if part.label == label)


def _zones(block, solution=None):
    zones = list(block.statement)
    for part in block.parts:
        zones += [z for z in (part.question, part.answer) if z]
        zones += part.extra_question
    return zones


def _crop_text(regions, zone) -> str:
    """Texte du rectangle (géométrie, avant blanchiment)."""
    return regions.page(zone.page).text_in(zone.rect)


def _own_glyphs_hit(regions, zone) -> list[str]:
    """Glyphes propres touchés par un rectangle blanc (doit être vide)."""
    boxes = regions.whiten_plan(zone).boxes
    hits = []
    for span in regions.own_spans(zone):
        if not span.text.strip():
            continue
        if any(_intersect(span.ink_box, box) is not None for box in boxes):
            hits.append(span.text)
    return hits


# --- Régression 1 : les radicaux de l'exercice 1.50 ----------------------

def test_algebre_1_50_question_d_keeps_its_radical():
    """« d) ⁴√7⁵ » : l'indice 4 et le radicande 7 sont dans le cadre."""
    block, _, regions = _exercise("algebre", "1.50")
    zone = _part(block, "d").question
    text = _crop_text(regions, zone)
    assert "4" in text, text
    assert "7" in text, text
    # ... et ils sont réellement visibles après blanchiment (aucun pixel
    # effacé) : l'indice de racine ne doit jamais disparaître
    visible = regions.visible_text(zone)
    assert "4" in visible, visible
    assert "7" in visible, visible
    # le glyphe radical lui-même est revendiqué par la question d)
    radicals = [s for s in regions.own_spans(zone) if "\u221a" in s.text]
    assert radicals, "le signe radical doit appartenir à la question d)"
    assert _own_glyphs_hit(regions, zone) == []
    plan = regions.whiten_plan(zone)
    assert plan.own_hits == 0
    assert plan.boxes == []


@pytest.mark.parametrize("label", ["e", "f", "h", "i"])
def test_algebre_1_50_questions_keep_their_radical(label):
    """Les autres questions à radical gardent leur signe et son indice."""
    block, _, regions = _exercise("algebre", "1.50")
    zone = _part(block, label).question
    assert any("\u221a" in s.text for s in regions.own_spans(zone)), label
    assert regions.whiten_plan(zone).own_hits == 0


@pytest.mark.parametrize("label", ["h", "i"])
def test_algebre_1_50_answers_keep_radical_and_ab(label):
    """Réponses h) et i) : « −ab ³√b² » et « 2ab ⁴√2ab³ » restent entières."""
    block, _, regions = _exercise("algebre", "1.50")
    zone = _part(block, label).answer
    words = regions.visible_words(zone)
    text = regions.visible_text(zone).replace(" ", "")
    assert "ab" in text, words
    assert any("\u221a" in word for word in words), words
    assert _own_glyphs_hit(regions, zone) == []
    plan = regions.whiten_plan(zone)
    assert plan.own_hits == 0
    assert plan.dropped == 0


def test_algebre_1_50_no_own_glyph_is_whitened_anywhere():
    """Aucune image de l'exercice 1.50 ne perd un de ses glyphes."""
    block, _, regions = _exercise("algebre", "1.50")
    for zone in _zones(block):
        assert _own_glyphs_hit(regions, zone) == [], zone.rect
        assert regions.whiten_plan(zone).own_hits == 0


# --- Régression 2 : la réponse b) de l'exercice 3.4 ----------------------

def _claimed_text_below(regions, zone, y: float) -> str:
    return "".join(span.text for span in sorted(
        (s for s in regions.own_spans(zone) if s.bbox[1] > y),
        key=lambda s: s.bbox[0]))


def test_algebre_3_4_answer_b_keeps_final_fraction():
    """La réponse b) garde sa deuxième ligne « { 1 / (m − 3) } ».

    Le dénominateur « m − 3 » est sous la barre de fraction (y > 510) : il doit
    être revendiqué par la réponse b), sinon la fraction serait tronquée.
    """
    block, _, regions = _exercise("algebre", "3.4")
    zone = _part(block, "b").answer
    assert zone.rect[3] > 523.0, zone.rect  # la zone descend sous le « 3 »
    below = _claimed_text_below(regions, zone, 510.0).replace(" ", "")
    assert "m−3" in below, below
    assert _own_glyphs_hit(regions, zone) == []
    # et la barre de fraction est dans le cadre
    assert zone.rect[1] < 509.9 < zone.rect[3]


def test_algebre_3_4_next_zone_has_no_denominator_of_b():
    """Ni la question c) ni la réponse c) ne récupèrent le « m − 3 » de b)."""
    block, _, regions = _exercise("algebre", "3.4")
    part_c = _part(block, "c")
    question_text = _crop_text(regions, part_c.question)
    assert "m − 3" not in question_text
    assert "m-3" not in question_text
    answer = part_c.answer
    visible = regions.visible_text(answer).replace(" ", "")
    assert "m−3" not in visible, regions.visible_words(answer)
    # l'image de la réponse c) commence sous le dénominateur de b)
    denominator_bottom = 523.7
    assert answer.rect[1] >= denominator_bottom - 0.5, answer.rect
    assert _own_glyphs_hit(regions, answer) == []


def test_algebre_3_4_answer_b_zone_starts_below_answer_a():
    """La réponse b) englobe sa fraction et ne mord pas sur la réponse c)."""
    block, _, regions = _exercise("algebre", "3.4")
    answer_b = _part(block, "b").answer
    answer_c = _part(block, "c").answer
    assert answer_b.page == answer_c.page == 221
    assert answer_b.rect[3] <= answer_c.rect[1] + 1.0
    # la fraction est dans la réponse b) : la zone descend sous la barre
    assert answer_b.rect[3] > 511.6


# --- Régression 3 : l'exposant de la question b) de 3.4 ------------------

def _exponent_spans(regions, zone):
    """Glyphes de petite taille (exposants/indices) dans une boîte de ligne."""
    boxes = regions.own_line_boxes(zone)
    out = []
    for span in regions.own_spans(zone):
        if not span.text.strip() or span.size >= 10.0:
            continue
        if any(_intersect(span.ink_box, box) is not None for box in boxes):
            out.append(span)
    return out


def test_algebre_3_4_question_b_keeps_its_exponent():
    """« m²x − 2mx − m » : l'exposant « 2 » (petit span) est protégé.

    L'attribution par origine seule envoyait ce glyphe (origine 430,3, ligne de
    base 442,7) vers la région précédente : il était blanchi. La boîte de ligne
    propre de la question b) doit le contenir, et aucun rectangle blanc ne doit
    l'intersecter.
    """
    block, _, regions = _exercise("algebre", "3.4")
    zone = _part(block, "b").question
    boxes = regions.own_line_boxes(zone)
    assert boxes, "la question b) doit avoir au moins une boîte de ligne"
    exponents = _exponent_spans(regions, zone)
    assert any(span.text == "2" for span in exponents), \
        [(s.text, s.size) for s in exponents]
    exponent = next(span for span in exponents if span.text == "2")
    # le glyphe est aussi revendiqué par la question (attribution corrigée)
    assert exponent.key in zone.claims
    plan = regions.whiten_plan(zone)
    assert plan.own_hits == 0
    for box in plan.boxes:
        assert _intersect(exponent.ink_box, box) is None, (box,
                                                           exponent.bbox)


def test_algebre_3_4_question_b_no_removed_pixel_in_line_boxes(tmp_path):
    """Contrôle indépendant : aucun pixel sombre retiré dans une boîte de ligne."""
    block, _, regions = _exercise("algebre", "3.4")
    zone = _part(block, "b").question
    doc, _ = _subject("algebre")
    plan = regions.whiten_plan(zone)
    path = tmp_path / "3.4-b.png"
    _, _, diff = render_crop(doc, zone, path, margin=0.0,
                             whiten=plan.boxes,
                             watch=regions.own_line_boxes(zone),
                             allowed=plan.allowed,
                             strict=plan.mode == "headings")
    assert diff.inside == 0, diff
    assert diff.outside == 0, diff
    assert not diff.error


def test_algebre_3_4_question_b_exponent_is_rendered(tmp_path):
    """L'exposant « 2 » de m² est peint dans l'image finale (mode headings)."""
    block, _, regions = _exercise("algebre", "3.4")
    zone = _part(block, "b").question
    exponent = next(span for span in _exponent_spans(regions, zone)
                    if span.text == "2")
    doc, _ = _subject("algebre")
    plan = regions.whiten_plan(zone)
    path = tmp_path / "3.4-b-exponent.png"
    render_crop(doc, zone, path, margin=0.0, whiten=plan.boxes,
                watch=regions.own_line_boxes(zone),
                allowed=plan.allowed, strict=plan.mode == "headings")
    pixmap = pymupdf.Pixmap(str(path))
    clip = crop_clip(doc, zone, 0.0)
    assert ink_pixels(pixmap, clip, exponent.ink_box) > 0
    assert "2" in regions.visible_text(zone)


# --- Régression 4 : réponses vides / graphique commun (7.19) -------------

def _catalog() -> dict:
    if not CATALOG_PATH.exists():
        pytest.fail("data/catalog.json absent : lancer extract/.venv/bin/python "
                    "extract/run.py")
    return json.loads(CATALOG_PATH.read_text())


def _catalog_exercise(exercise_id: str) -> dict:
    for exercise in _catalog()["exercises"]:
        if exercise["id"] == exercise_id:
            return exercise
    raise AssertionError(f"{exercise_id} absent du catalogue")


def test_algebre_7_19_shared_graph_answers_are_null():
    """La solution 7.19 est un graphique commun : c) et e) sont vides → null."""
    exercise = _catalog_exercise("algebre-7.19")
    answers = {part["label"]: part["answer"] for part in exercise["parts"]}
    assert answers["c"] is None
    assert answers["e"] is None
    assert exercise["solution"] is not None
    assert exercise["solution"]["crops"], "le graphique complet doit rester"
    for crop in exercise["solution"]["crops"]:
        path = ROOT / "data" / crop["src"]
        assert path.exists(), crop["src"]
        assert crop["h"] > 200  # le graphique entier, pas un fragment


def test_physique_2_30_answer_a_is_null():
    """Physique 2.30 (a) : l'image ne contient que son marqueur → null."""
    exercise = _catalog_exercise("physique-2.30")
    part = next(p for p in exercise["parts"] if p["label"] == "a")
    assert part["answer"] is None


# --- Régression 5 : figure d'énoncé coupée (physique 2.30) ---------------

def test_physique_2_30_statement_keeps_the_whole_figure(tmp_path):
    """Le schéma (câble, B, 30°) à droite de l'énoncé reste dans l'énoncé."""
    block, _, regions = _exercise("physique", "2.30")
    zone = block.statement[0]
    images = [f for f in zone.figures if f[3] - f[1] > 100]
    assert images, "la figure de l'énoncé doit être rattachée à l'énoncé"
    figure = images[0]
    # la découpe descend jusqu'au bas de la figure (et non au premier marqueur)
    assert zone.rect[3] >= figure[3] - 1.0
    assert zone.rect[2] >= figure[2] - 1.0
    assert zone.rect[3] > 700.0
    # le « 30° » de la figure : texte du rectangle et encre réellement rendue
    assert "30" in regions.page(zone.page).text_in(zone.rect)
    doc, _ = _subject("physique")
    plan = regions.whiten_plan(zone)
    path = tmp_path / "phy-2.30-statement.png"
    render_crop(doc, zone, path, margin=0.0, whiten=plan.boxes,
                watch=regions.own_line_boxes(zone))
    pixmap = pymupdf.Pixmap(str(path))
    clip = crop_clip(doc, zone, 0.0)
    band = (figure[0] + 60, figure[3] - 25, figure[2], figure[3])
    assert ink_pixels(pixmap, clip, band) > 0, band
    # la figure n'appartient à aucune sous-question
    for part in block.parts:
        assert not [f for f in part.question.figures
                    if f[3] - f[1] > 100], part.label


# --- Régression 6 : blanchiment limité aux titres (WHITEN_MODE) ----------

def test_whiten_mode_defaults_to_headings():
    """La production ne blanchit que les titres d'autres blocs."""
    assert get_whiten_mode() == "headings"


def _claimed_words(regions, zone):
    """(texte, bbox) des mots revendiqués par la zone (donc non blanchis)."""
    out = []
    for word in regions.words(zone.page):
        bbox = tuple(word[:4])
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        if not (zone.rect[0] <= cx <= zone.rect[2]
                and zone.rect[1] <= cy <= zone.rect[3]):
            continue
        if regions._word_claimed(zone, zone.page, bbox):
            out.append((word[4], bbox))
    return out


def test_algebre_7_101_statement_keeps_figure_cotes(tmp_path):
    """Les cotes « 4 » (gauche) et « x » (droite) de la figure restent visibles."""
    block, _, regions = _exercise("algebre", "7.101")
    zone = block.statement[0]
    words = _claimed_words(regions, zone)
    left = [bbox for text, bbox in words if text == "4" and bbox[0] < 100]
    right = [bbox for text, bbox in words if text == "x" and bbox[0] > 280]
    assert left, words
    assert right, words
    # ce sont des étiquettes de la figure de l'énoncé, pas du contenu étranger
    assert any(span.text.strip() == "4" for span in regions.own_spans(zone))
    assert any(span.text.strip() == "x" for span in regions.own_spans(zone))
    # aucun blanchiment dans cet énoncé : l'image est identique au rendu brut
    plan = regions.whiten_plan(zone)
    assert plan.boxes == []
    doc, _ = _subject("algebre")
    raw_path = tmp_path / "7.101-raw.png"
    out_path = tmp_path / "7.101-out.png"
    render_crop(doc, zone, raw_path, margin=0.0)
    _, _, diff = render_crop(doc, zone, out_path, margin=0.0,
                             whiten=plan.boxes,
                             watch=regions.own_line_boxes(zone),
                             allowed=plan.allowed,
                             strict=plan.mode == "headings")
    assert diff.removed == 0 and diff.outside == 0, diff
    assert pymupdf.Pixmap(str(raw_path)).samples \
        == pymupdf.Pixmap(str(out_path)).samples
    # et les deux cotes ont bien de l'encre dans l'image livrée
    pixmap = pymupdf.Pixmap(str(out_path))
    clip = crop_clip(doc, zone, 0.0)
    for bbox in (left[0], right[0]):
        assert ink_pixels(pixmap, clip, bbox) > 0, bbox


def test_algebre_1_15_statement_renders_identically_to_raw(tmp_path):
    """Le tableau de 1.15 garde ses traits : aucun pixel effacé (identique au brut)."""
    block, _, regions = _exercise("algebre", "1.15")
    zone = block.statement[0]
    plan = regions.whiten_plan(zone)
    # aucun titre étranger dans le cadre → aucun blanchiment
    assert plan.boxes == []
    doc, _ = _subject("algebre")
    raw_path = tmp_path / "1.15-raw.png"
    out_path = tmp_path / "1.15-out.png"
    render_crop(doc, zone, raw_path, margin=0.0)
    _, _, diff = render_crop(doc, zone, out_path, margin=0.0,
                             whiten=plan.boxes,
                             watch=regions.own_line_boxes(zone),
                             allowed=plan.allowed,
                             strict=plan.mode == "headings")
    assert diff.removed == 0 and diff.outside == 0, diff
    raw = pymupdf.Pixmap(str(raw_path))
    out = pymupdf.Pixmap(str(out_path))
    assert raw.width == out.width and raw.height == out.height
    assert raw.samples == out.samples


def test_geometrie_2_57_answer_a_has_no_solution_title(tmp_path):
    """« Solution 2.57 » n'apparaît pas dans la réponse a).

    La grande accolade de la réponse remonte dans la bande du titre : le titre
    ne peut pas être exclu par le rectangle. C'est un en-tête, jamais le
    contenu d'une réponse : il est blanchi, et la protection des glyphes
    propres garantit que l'accolade reste entière.
    """
    block, _, regions = _exercise("geometrie", "2.57")
    zone = _part(block, "a").answer
    words = regions.visible_words(zone)
    assert "Solution" not in words, words
    assert "2.57" not in words, words
    plan = regions.whiten_plan(zone)
    own_title = next(m for m in regions.titles(zone.page)
                     if m.group == zone.group)
    # le titre du bloc est bien traité comme un en-tête dans une sous-question
    assert any(_intersect(box, own_title.rect) is not None
               for box in plan.boxes), plan.boxes
    assert plan.own_hits == 0
    doc, _ = _subject("geometrie")
    path = tmp_path / "2.57-s-a.png"
    _, _, diff = render_crop(doc, zone, path, margin=0.0, whiten=plan.boxes,
                             watch=regions.own_line_boxes(zone),
                             allowed=plan.allowed, strict=True)
    # rien de propre n'est effacé, et rien hors titre n'est effacé
    assert diff.inside == 0 and diff.outside == 0, diff
    assert not diff.error


def test_algebre_7_106_statement_has_no_footer(tmp_path):
    """L'énoncé 7.106 ne montre ni « ALGÈBRE » ni le filet de pied."""
    block, _, regions = _exercise("algebre", "7.106")
    for zone in block.statement:
        page = regions.page(zone.page)
        # clamping : le cadre s'arrête au-dessus du pied de page
        assert zone.rect[3] <= page.body_bottom
        words = [w.lower() for w in regions.visible_words(zone)]
        assert "algèbre" not in words and "algebre" not in words, words
        plan = regions.whiten_plan(zone)
        # aucune encre de pied n'est effacée : elle n'est jamais dans le cadre
        assert all(box[3] <= page.body_bottom for box in plan.boxes)


def test_only_foreign_titles_are_whitened(tmp_path):
    """Un titre d'un autre bloc est blanchi ; celui du bloc ne l'est jamais."""
    doc, solution, zones, regions = _solution_crops("geometrie", "2.24")
    zone = max(zones, key=lambda z: z.rect[3])
    plan = regions.whiten_plan(zone)
    assert plan.mode == "headings"
    assert plan.boxes, "le titre du bloc suivant chevauche cette découpe"
    # chaque rectangle blanc est dans l'enveloppe d'un titre étranger
    for box in plan.boxes:
        assert any(_contains(allowed, box) for allowed in plan.allowed), box
    own_titles = [m for m in regions.titles(zone.page) if m.group == zone.group]
    assert own_titles
    for box in plan.boxes:
        for mark in own_titles:
            assert _intersect(box, mark.rect) is None
    path = tmp_path / "2.24-solution.png"
    _, _, diff = render_crop(doc, zone, path, margin=0.0, whiten=plan.boxes,
                             watch=regions.own_line_boxes(zone),
                             allowed=plan.allowed, strict=True)
    assert diff.outside == 0 and diff.inside == 0, diff
    assert not diff.error
    pixmap = pymupdf.Pixmap(str(path))
    clip = crop_clip(doc, zone, 0.0)
    # le titre étranger a disparu, le titre propre est intact
    foreign = [m for m in regions.titles(zone.page)
               if m.group != zone.group and _intersect(m.rect, zone.rect)]
    assert foreign
    for mark in foreign:
        piece = _intersect(mark.rect, zone.rect)
        assert ink_pixels(pixmap, clip, piece) == 0, mark.rect
    for mark in own_titles:
        piece = _intersect(mark.rect, zone.rect)
        if piece is not None:
            assert ink_pixels(pixmap, clip, piece) > 0


# --- Contrôle global ------------------------------------------------------

def test_catalog_reports_no_whitened_content():
    """Le catalogue publié ne signale aucun glyphe propre blanchi."""
    if not CATALOG_PATH.exists():
        pytest.fail("data/catalog.json absent : lancer extract/.venv/bin/python "
                    "extract/run.py")
    catalog = json.loads(CATALOG_PATH.read_text())
    whitening = catalog["whitening"]
    assert whitening["ownWhitened"] == 0
    assert whitening["dropped"] == 0
    crops = 0
    for exercise in catalog["exercises"]:
        crops += len(exercise["statement"])
        for part in exercise["parts"]:
            crops += int(part["question"] is not None)
            crops += int(part["answer"] is not None)
        if exercise["solution"]:
            crops += len(exercise["solution"]["crops"])
    assert whitening["images"] == crops, (whitening["images"], crops)


def test_catalog_reports_title_only_whitening():
    """Le catalogue publié est en mode headings : 0 pixel effacé hors titres."""
    catalog = _catalog()
    whitening = catalog["whitening"]
    assert whitening["mode"] == "headings"
    assert whitening["removedOutsideTitlePixels"] == 0
    assert whitening["diffErrors"] == 0
    # il reste des fragments de voisins (compromis accepté), mais peu
    assert 0 < whitening["fragmentImages"] < 490


def test_fragment_cases_are_flagged_low_confidence():
    """Chaque découpe avec fragment de voisin porte le flag `low_confidence`."""
    for exercise_id in ("geometrie-2.57", "algebre-7.101", "geometrie-2.24"):
        exercise = _catalog_exercise(exercise_id)
        codes = {flag["code"] for flag in exercise["flags"]}
        assert "low_confidence" in codes, (exercise_id, codes)


def test_whiten_mode_all_remains_available():
    """Le mode ``all`` (comparaison) reste fonctionnel : il peint plus que les titres."""
    block, _, regions = _exercise("algebre", "7.101")
    zone = block.statement[0]
    plan = regions.whiten_plan(zone, mode="all")
    assert plan.mode == "all"
    # en mode all, le contenu des sous-questions voisines serait blanchi
    assert plan.boxes
    assert plan.own_hits == 0
    # ... alors que le mode headings ne peint rien dans cet énoncé
    assert regions.whiten_plan(zone, mode="headings").boxes == []


def test_own_glyphs_on_a_random_sample_of_exercises():
    """Échantillon reproductible : aucun glyphe propre blanchi (3 matières)."""
    rng = random.Random(20261121)
    plan = {"algebre": ["1.50", "3.4", "1.12", "1.45"], "geometrie": ["2.57"],
            "physique": ["1.3"]}
    for subject, numbers in plan.items():
        for number in numbers:
            try:
                block, _, regions = _exercise(subject, number)
            except StopIteration:
                continue
            zones = _zones(block)
            assert zones, (subject, number)
            sample = rng.sample(zones, min(12, len(zones)))
            for zone in sample:
                assert _own_glyphs_hit(regions, zone) == [], (subject, number,
                                                             zone.rect)
                assert regions.whiten_plan(zone).own_hits == 0


def test_fraction_and_radical_zones_have_ink_checks():
    """Chaque radical de la page 34 est revendiqué par une seule question.

    Un radical partagé (ou orphelin) serait blanchi dans la question qui le
    porte : on vérifie qu'il n'appartient qu'à une sous-question de l'exercice.
    """
    block, _, regions = _exercise("algebre", "1.50")
    page = 34
    radicals = {span.key: span for span, _line in
                regions.span_map(page).values() if is_extension_span(span)}
    assert radicals, "la page 34 doit porter des radicaux"
    parts = [zone for zone in _zones(block) if zone.role == "part"]
    claimed = 0
    for key, span in radicals.items():
        owners = [zone for zone in parts if key in zone.claims]
        if not owners:
            continue  # radical d'un autre exercice de la page
        assert len(owners) == 1, (span.text, span.bbox)
        claimed += 1
    assert claimed == 9, claimed  # les neuf sous-questions de 1.50

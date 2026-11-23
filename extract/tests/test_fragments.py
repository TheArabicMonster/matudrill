"""Tests du blanchiment des fragments voisins.

Une découpe ne doit montrer que sa propre région : ni le bas du titre
« Solution 2.57 », ni la ligne suivante, ni la réponse d'à côté, ni le pied de
page.

Depuis `WHITEN_MODE="headings"` (production), on ne peint en blanc que les
titres d'autres exercices/solutions ; les rectangles sont resserrés au calcul
(borne verticale entre deux lignes de base voisines, borne horizontale à la
colonne). Un fragment d'une autre ligne peut donc rester visible au bord : il
est mesuré par l'audit des fragments et signalé `low_confidence` (compromis
accepté : un fragment est un défaut mineur, un symbole manquant rend
l'exercice faux). Les tests ci-dessous portent sur le texte *revendiqué* par
la région (celui qui lui appartient), pas sur l'absence de tout pixel voisin.

Lancer depuis la racine du dépôt :

    extract/.venv/bin/python -m pytest extract/tests -q
"""

from __future__ import annotations

import re
import sys
from functools import lru_cache
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "extract"))

from exercises import BlockBuilder, TitleIndex  # noqa: E402
from pdf_layout import Document  # noqa: E402
from regions import build_index  # noqa: E402
from solutions import SolutionSet, attach_answers  # noqa: E402


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
    solution = SolutionSet(doc, index, {number: block.title}).get(number)
    attach_answers(block, solution)
    regions = build_index(doc, [block], [solution] if solution else [])
    return block, solution, regions


def _part(block, label: str):
    return next(part for part in block.parts if part.label == label)


def visible_text(regions, zone) -> str:
    return regions.visible_text(zone)


def visible_words(regions, zone) -> list[str]:
    return regions.visible_words(zone)


def markers(words) -> list[str]:
    """Étiquettes « a) », « (b) », « 1. » en début de mot."""
    found = []
    for word in words:
        match = re.match(r"^\(?([A-Za-z]|\d{1,2})\)?[.)]$", word)
        if match:
            found.append(word)
    return found


# --- Géométrie 2.57 (solutions p. 89, deux colonnes) ----------------------

def test_geometrie_2_57_answer_a_has_no_title():
    """La réponse a) ne montre pas le bas du titre « Solution 2.57 »."""
    block, _, regions = _exercise("geometrie", "2.57")
    text = visible_text(regions, _part(block, "a").answer)
    assert "Solution" not in text
    assert "2.57" not in text


def test_geometrie_2_57_answer_d_has_no_ed():
    """La réponse d) ne montre pas la ligne « ED_θ = ℝ \\ {…} » de b).

    Le texte revendiqué par d) ne contient pas la ligne de b) ; un fragment de
    pixel éventuel au bord est un compromis accepté, signalé `low_confidence`.
    """
    block, _, regions = _exercise("geometrie", "2.57")
    text = visible_text(regions, _part(block, "d").answer)
    assert "ED" not in text
    assert "ℝ" not in text


def test_geometrie_2_57_answer_b_keeps_its_own_ed():
    """Contrôle inverse : ED_θ appartient bien à la réponse b)."""
    block, _, regions = _exercise("geometrie", "2.57")
    text = visible_text(regions, _part(block, "b").answer)
    assert "ED" in text.replace(" ", "")


def test_geometrie_2_57_answers_have_no_foreign_marker():
    """Aucune réponse ne contient l'étiquette d'une autre réponse."""
    block, _, regions = _exercise("geometrie", "2.57")
    for label in "abcdef":
        zone = _part(block, label).answer
        words = visible_words(regions, zone)
        assert markers(words) == [f"{label})"], (label, markers(words))


# --- Algèbre 7.106 (pied de page) ----------------------------------------

def test_algebre_7_106_statement_has_no_footer():
    """L'énoncé ne contient ni le filet de pied ni « ALGÈBRE »."""
    block, _, regions = _exercise("algebre", "7.106")
    page = regions.page(block.statement[0].page)
    for zone in block.statement:
        assert zone.rect[3] <= page.body_bottom
        text = visible_text(regions, zone).lower()
        assert "algèbre" not in text
        assert "algebre" not in text


def test_algebre_7_106_statement_keeps_its_text():
    """Contrôle inverse : l'énoncé garde bien ses fonctions f et g."""
    block, _, regions = _exercise("algebre", "7.106")
    text = visible_text(regions, block.statement[0])
    assert "fonctions" in text
    assert "distance" in text


# --- Algèbre 1.50 (réponses en trois colonnes, p. 194) -------------------

def test_algebre_1_50_answer_d_only_marker():
    """La réponse d) ne contient que son propre marqueur « d) »."""
    block, _, regions = _exercise("algebre", "1.50")
    zone = _part(block, "d").answer
    words = visible_words(regions, zone)
    assert markers(words) == ["d)"], markers(words)
    text = visible_text(regions, zone)
    assert "a)" not in text
    assert "e)" not in text


def test_algebre_1_50_answers_marker_isolation():
    """Chaque réponse ne montre que son marqueur (a) … i))."""
    block, _, regions = _exercise("algebre", "1.50")
    for part in block.parts:
        if part.answer is None:
            continue
        words = visible_words(regions, part.answer)
        assert markers(words) == [f"{part.label})"], (part.label,
                                                     markers(words))


# --- zone utile de la page ----------------------------------------------

def test_body_bounds_exclude_header_and_footer():
    doc, _ = _subject("algebre")
    page = doc.page(142)  # p. 143
    assert page.body_top < 50
    assert 755 < page.body_bottom < 765
    for index in (12, 33, 142, 182):
        layout = doc.page(index)
        assert layout.body_top < layout.body_bottom


def test_all_zones_are_inside_body():
    """Aucun rectangle ne sort de la zone utile (ni en-tête ni pied)."""
    for subject, number in (("geometrie", "2.57"), ("algebre", "7.106"),
                            ("algebre", "1.50"), ("physique", "1.3")):
        block, solution, regions = _exercise(subject, number)
        zones = list(block.statement)
        zones += [p.question for p in block.parts if p.question]
        zones += [p.answer for p in block.parts if p.answer]
        for zone in zones:
            page = regions.page(zone.page)
            assert zone.rect[1] >= page.body_top - 0.01, (subject, number)
            assert zone.rect[3] <= page.body_bottom + 0.01, (subject, number)


def test_parts_never_include_their_title():
    """Le haut d'une sous-question est sous le bas du titre."""
    for subject, number in (("geometrie", "2.57"), ("algebre", "1.50"),
                            ("algebre", "7.106")):
        block, _, _ = _exercise(subject, number)
        title_bottom = block.title_row.y1
        for part in block.parts:
            if part.question is None:
                continue
            assert part.question.rect[1] >= title_bottom, (subject, number,
                                                           part.label)

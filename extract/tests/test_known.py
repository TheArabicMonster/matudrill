"""Tests de non-régression sur des exercices dont la découpe est connue.

Ils s'appuient sur `data/catalog.json` (produit par `extract/run.py`) et
recalculent quelques blocs pour vérifier les géométries et le texte des
réponses. Lancer depuis la racine du dépôt :

    extract/.venv/bin/python -m pytest extract/tests -q
"""

from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "extract"))

from exercises import BlockBuilder, TitleIndex  # noqa: E402
from pdf_layout import Document  # noqa: E402
from solutions import SolutionSet, attach_answers  # noqa: E402

CATALOG_PATH = ROOT / "data" / "catalog.json"
EXPECTED_COUNTS = {"algebre": 530, "geometrie": 146, "physique": 117}


# --- outils ---------------------------------------------------------------

@pytest.fixture(scope="session")
def catalog() -> dict:
    if not CATALOG_PATH.exists():
        pytest.fail("data/catalog.json absent : lancer extract/.venv/bin/python "
                    "extract/run.py")
    return json.loads(CATALOG_PATH.read_text())


def get_exercise(catalog: dict, exercise_id: str) -> dict:
    for exercise in catalog["exercises"]:
        if exercise["id"] == exercise_id:
            return exercise
    raise AssertionError(f"{exercise_id} absent du catalogue")


@lru_cache(maxsize=None)
def _subject(subject: str):
    """Document, index et solutions d'une matière (chargés une seule fois)."""
    doc = Document(str(ROOT / "pdfs" / f"{subject}.pdf"))
    index = TitleIndex(doc)
    return doc, index


def build_block(subject: str, number: str):
    """Reconstruit un exercice et sa solution comme le fait le pipeline."""
    doc, index = _subject(subject)
    builder = BlockBuilder(doc, index)
    row = next(row for page in index.exercises
               for num, row in index.exercises[page] if num == number)
    block = builder.build("exercise", number, row)
    solutions = SolutionSet(doc, index, {number: block.title})
    solution = solutions.get(number)
    attach_answers(block, solution)
    return doc, block, solution


def flag_codes(exercise: dict) -> set[str]:
    return {flag["code"] for flag in exercise["flags"]}


# --- structure du catalogue ----------------------------------------------

def test_catalog_shape(catalog):
    assert catalog["version"] == 1
    assert re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", catalog["generatedAt"])
    assert {s["id"] for s in catalog["subjects"]} == set(EXPECTED_COUNTS)
    assert all(s["pages"] > 0 for s in catalog["subjects"])


def test_exercise_counts(catalog):
    counts = {}
    for exercise in catalog["exercises"]:
        counts[exercise["subject"]] = counts.get(exercise["subject"], 0) + 1
    assert counts == EXPECTED_COUNTS


def test_ids_are_unique(catalog):
    ids = [e["id"] for e in catalog["exercises"]]
    assert len(ids) == len(set(ids))
    for exercise in catalog["exercises"]:
        assert exercise["id"] == f"{exercise['subject']}-{exercise['number']}"


def test_sections_exist_for_every_exercise(catalog):
    known = {(s["subject"], s["id"]) for s in catalog["sections"]}
    for exercise in catalog["exercises"]:
        assert (exercise["subject"], exercise["section"]) in known, exercise["id"]


def test_every_part_has_a_question(catalog):
    for exercise in catalog["exercises"]:
        for part in exercise["parts"]:
            assert part["question"] is not None, exercise["id"]
            assert part["question"]["page"] in exercise["pages"] or \
                part["question"]["page"] > exercise["pages"][-1]


def test_crops_files_and_sizes(catalog):
    for exercise in catalog["exercises"][:60]:
        for crop in _all_crops(exercise):
            path = ROOT / "data" / crop["src"]
            assert path.exists(), crop["src"]
            assert crop["w"] > 40 and crop["h"] > 20, crop["src"]


def _all_crops(exercise: dict):
    for crop in exercise["statement"]:
        yield crop
    for part in exercise["parts"]:
        for key in ("question", "answer"):
            if part[key]:
                yield part[key]
    if exercise["solution"]:
        for crop in exercise["solution"]["crops"]:
            yield crop


def test_solution_pages_are_declared(catalog):
    for exercise in catalog["exercises"]:
        solution = exercise["solution"]
        if not solution:
            continue
        assert solution["crops"], exercise["id"]
        for crop in solution["crops"]:
            assert crop["page"] in solution["pages"], exercise["id"]


# --- Algèbre 1.1 ----------------------------------------------------------

def test_algebre_1_1(catalog):
    """5 sous-questions a–e sur deux colonnes, réponses page 183."""
    exercise = get_exercise(catalog, "algebre-1.1")
    assert exercise["pages"] == [13]
    assert exercise["title"] is None
    assert exercise["section"] == "1.1"
    assert [p["label"] for p in exercise["parts"]] == ["a", "b", "c", "d", "e"]
    for part in exercise["parts"]:
        assert part["question"]["page"] == 13
        assert part["answer"] is not None, part["label"]
        assert part["answer"]["page"] == 183
    assert exercise["solution"]["pages"] == [183]
    assert exercise["solution"]["finalOnly"] is False
    assert exercise["flags"] == []


def test_algebre_1_1_two_columns():
    """Les marqueurs a) et b) sont sur la même ligne, à deux abscisses."""
    _, block, _ = build_block("algebre", "1.1")
    left = [p.question.rect[0] for p in block.parts if p.label in "ace"]
    right = [p.question.rect[0] for p in block.parts if p.label in "bd"]
    assert max(left) - min(left) < 2   # même colonne
    assert max(right) - min(right) < 2
    assert min(right) - min(left) > 200
    # même hauteur pour a) et b) (deux colonnes d'une même rangée)
    a = next(p for p in block.parts if p.label == "a").question.rect
    b = next(p for p in block.parts if p.label == "b").question.rect
    assert abs(a[1] - b[1]) < 2
    assert a[2] - b[0] <= 4  # le cadre de a) s'arrête au bord de b)


def test_algebre_1_1_answer_text():
    """La réponse a) contient bien l'intersection des deux ensembles."""
    doc, block, _ = build_block("algebre", "1.1")
    part = next(p for p in block.parts if p.label == "a")
    text = doc.page(part.answer.page - 1).text_in(part.answer.rect)
    assert "A" in text and "B" in text


# --- Algèbre 1.2 ----------------------------------------------------------

def test_algebre_1_2_split(catalog):
    exercise = get_exercise(catalog, "algebre-1.2")
    assert exercise["pages"] == [13, 14]
    assert "split_pages" in flag_codes(exercise)
    assert [p["label"] for p in exercise["parts"]] == ["a", "b", "c", "d", "e"]
    assert all(p["question"]["page"] == 14 for p in exercise["parts"])
    assert exercise["statement"][0]["page"] == 13


# --- Physique 1.3 ---------------------------------------------------------

def test_physique_1_3(catalog):
    exercise = get_exercise(catalog, "physique-1.3")
    assert exercise["title"].replace("’", "'") == "Le prix d'un bain"
    assert [p["label"] for p in exercise["parts"]] == ["a", "b", "c"]
    assert exercise["pages"] == [29]
    assert exercise["solution"]["finalOnly"] is True
    assert exercise["flags"] == []


def test_physique_1_3_answer_contains_value():
    """Le texte du cadre de la réponse (a) contient « 18,81 »."""
    doc, block, _ = build_block("physique", "1.3")
    part = next(p for p in block.parts if p.label == "a")
    assert part.answer is not None
    text = doc.page(part.answer.page - 1).text_in(part.answer.rect)
    assert "18,81" in text
    assert part.answer.page == 107


def test_physique_1_3_statement_excludes_parts():
    doc, block, _ = build_block("physique", "1.3")
    statement = block.statement[0]
    text = doc.page(statement.page - 1).text_in(statement.rect)
    assert "Le prix" in text
    assert "Déterminez" not in text

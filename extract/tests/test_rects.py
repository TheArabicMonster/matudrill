"""Contrôle du rectangle PDF (`rect`) publié pour chaque image du catalogue.

Chaque objet image `{src, w, h, page}` porte `rect: [x0, y0, x1, y1]` en points
PDF (origine en haut à gauche) : c'est le rectangle exact utilisé pour rendre
le PNG, marges comprises et ramené dans la page. L'app s'en sert pour rouvrir
la découpe dans le PDF (écran « Recadrer »).

Lancer depuis la racine du dépôt :

    extract/.venv/bin/python -m pytest extract/tests -q
"""

from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "extract"))

CATALOG_PATH = ROOT / "data" / "catalog.json"
# 150 dpi : 1 pt = 150/72 px (voir render.DPI).
PT_TO_PX = 150 / 72.0
# Tolérance entre la taille du rect et celle du PNG (arrondi des pixels).
SIZE_TOLERANCE_PX = 2.0


@pytest.fixture(scope="session")
def catalog() -> dict:
    if not CATALOG_PATH.exists():
        pytest.fail("data/catalog.json absent : lancer extract/.venv/bin/python "
                    "extract/run.py")
    return json.loads(CATALOG_PATH.read_text())


def all_crops(exercise: dict):
    """Toutes les images d'un exercice : énoncé, questions, réponses, solution."""
    for crop in exercise["statement"]:
        yield "statement", crop
    for part in exercise["parts"]:
        for key in ("question", "answer"):
            if part[key]:
                yield f"{key}:{part['label']}", part[key]
    if exercise["solution"]:
        for index, crop in enumerate(exercise["solution"]["crops"]):
            yield f"solution:{index}", crop


@lru_cache(maxsize=None)
def _page_rect(subject: str, page_number: int) -> tuple[float, float]:
    doc = pymupdf.open(str(ROOT / "pdfs" / f"{subject}.pdf"))
    try:
        rect = doc[page_number - 1].rect
        return rect.width, rect.height
    finally:
        doc.close()


def _describe(exercise: dict, slot: str) -> str:
    return f"{exercise['id']} {slot}"


# --- présence et forme du rect -------------------------------------------

def test_every_crop_has_a_rect(catalog):
    """Toute image du catalogue porte un `rect` de quatre nombres au dixième."""
    count = 0
    for exercise in catalog["exercises"]:
        for slot, crop in all_crops(exercise):
            rect = crop.get("rect")
            assert rect is not None, _describe(exercise, slot)
            assert isinstance(rect, list) and len(rect) == 4, \
                _describe(exercise, slot)
            for value in rect:
                assert isinstance(value, (int, float)), _describe(exercise, slot)
                assert round(float(value), 1) == pytest.approx(value, abs=1e-9), \
                    _describe(exercise, slot)
            x0, y0, x1, y1 = rect
            assert x1 > x0 and y1 > y0, _describe(exercise, slot)
            count += 1
    assert count > 1000


# --- cohérence rect <-> PNG ----------------------------------------------

def test_rect_matches_pixel_size(catalog):
    """(x1-x0)/w et (y1-y0)/h valent 150/72 à 2 px près."""
    for exercise in catalog["exercises"]:
        for slot, crop in all_crops(exercise):
            x0, y0, x1, y1 = crop["rect"]
            width_px = (x1 - x0) * PT_TO_PX
            height_px = (y1 - y0) * PT_TO_PX
            assert abs(width_px - crop["w"]) <= SIZE_TOLERANCE_PX, \
                f"{_describe(exercise, slot)} : {crop['w']} px pour " \
                f"{x1 - x0:.1f} pt"
            assert abs(height_px - crop["h"]) <= SIZE_TOLERANCE_PX, \
                f"{_describe(exercise, slot)} : {crop['h']} px pour " \
                f"{y1 - y0:.1f} pt"


def test_rect_is_inside_the_page(catalog):
    """Le rect ne déborde ni de la page ni du haut de la page (clamping)."""
    for exercise in catalog["exercises"]:
        for slot, crop in all_crops(exercise):
            page_width, page_height = _page_rect(exercise["subject"],
                                                 crop["page"])
            x0, y0, x1, y1 = crop["rect"]
            limit = 0.2  # arrondi au dixième
            assert -limit <= x0 and x0 < x1 <= page_width + limit, \
                f"{_describe(exercise, slot)} : {crop['rect']} hors page " \
                f"({page_width:.1f} pt)"
            assert -limit <= y0 and y0 < y1 <= page_height + limit, \
                f"{_describe(exercise, slot)} : {crop['rect']} hors page " \
                f"({page_height:.1f} pt)"


# --- cas connu -----------------------------------------------------------

def test_algebre_1_1_statement_rect(catalog):
    """Énoncé d'Algèbre 1.1 (p. 13) : rectangle de référence du catalogue.

    Valeur mesurée : [44.3, 111.0, 532.2, 383.5], soit 1017 × 568 px à 150 dpi
    (identique au PNG de production). L'exemple « [40, 116, 555, 396] →
    ~1073 × 583 px » de SPEC.md illustre un recadrage MANUEL, pas la découpe
    automatique : le rect publié doit décrire le PNG réellement produit.
    Tolérance large (± 2 pt) pour ne pas casser au moindre arrondi de police.
    """
    exercise = next(e for e in catalog["exercises"] if e["id"] == "algebre-1.1")
    assert len(exercise["statement"]) == 1
    crop = exercise["statement"][0]
    assert crop["page"] == 13
    assert (crop["w"], crop["h"]) == (1017, 568)
    expected = [44.3, 111.0, 532.2, 383.5]
    for value, reference in zip(crop["rect"], expected):
        assert value == pytest.approx(reference, abs=2.0), crop["rect"]


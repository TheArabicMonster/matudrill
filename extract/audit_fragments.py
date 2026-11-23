#!/usr/bin/env python3
"""Audit des fragments visibles dans les découpes.

Relit un `catalog.json` et mesure, pour chaque image, la présence de contenu
appartenant à une autre région :

- `current` : la géométrie courante du pipeline, blanchiment appliqué → compte
  les fragments *résiduels* (mots étrangers non couverts par le blanchiment) ;
  exécute aussi le contrôle indépendant du blanchiment (pixels) ;
- `legacy`  : les rectangles d'une version antérieure (fichier JSON produit par
  l'ancien pipeline, voir `--zones`) et aucun blanchiment → tout mot étranger
  présent dans le rectangle était visible dans l'image livrée.

Contrôle indépendant du blanchiment (mode `current`) : chaque zone est rendue
deux fois, sans puis avec blanchiment. On compte les pixels sombres effacés et
ceux qui tombent dans une *boîte de ligne propre* de la zone : c'est une erreur
(un exposant, un indice ou un morceau de formule de la région a été effacé).
Les 30 images qui perdent le plus de pixels donnent des planches côte à côte
`sans / avec`, pour relecture humaine.

    extract/.venv/bin/python extract/audit_fragments.py --catalog data/catalog.json
    extract/.venv/bin/python extract/audit_fragments.py --catalog data/catalog.json \
        --mode legacy --zones /tmp/opencode/old_zones.json

Sortie : par matière, images auditées, images avec au moins un fragment, nombre
de mots étrangers visibles, puis le contrôle du blanchiment, puis des exemples.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "extract"))

from exercises import BlockBuilder, TitleIndex  # noqa: E402
from pdf_layout import Document  # noqa: E402
from regions import (DEFAULT_WHITEN_MODE, WHITEN_MODES, build_index,  # noqa: E402
                     get_whiten_mode, set_whiten_mode)
from render import crop_clip, render_whiten_diff, whiten_pixmap  # noqa: E402
from solutions import SolutionSet, attach_answers  # noqa: E402

SUBJECTS = {
    "algebre": "algebre.pdf",
    "geometrie": "geometrie.pdf",
    "physique": "physique.pdf",
}


class SubjectZones:
    """Toutes les zones nommables d'une matière, nommées comme dans run.py."""

    def __init__(self, subject: str):
        self.subject = subject
        self.doc = Document(str(ROOT / "pdfs" / SUBJECTS[subject]))
        self.index = TitleIndex(self.doc)
        builder = BlockBuilder(self.doc, self.index)
        self.blocks: dict[str, object] = {}
        for page in sorted(self.index.exercises):
            for number, row in self.index.exercises[page]:
                if number in self.blocks:
                    continue
                self.blocks[number] = builder.build("exercise", number, row)
        titles = {n: b.title for n, b in self.blocks.items()}
        self.solutions = SolutionSet(self.doc, self.index, titles)
        for number, block in self.blocks.items():
            attach_answers(block, self.solutions.get(number))
        self.regions = build_index(self.doc, self.blocks.values(),
                                   self.solutions.blocks.values())
        self.zones: dict[str, object] = {}
        for number, block in self.blocks.items():
            for i, zone in enumerate(block.statement):
                self.zones[f"{subject}-{number}-statement-{i}"] = zone
            for part in block.parts:
                if part.question:
                    self.zones[f"{subject}-{number}-q-{part.label}"] = \
                        part.question
                if part.answer:
                    self.zones[f"{subject}-{number}-s-{part.label}"] = \
                        part.answer
            solution = self.solutions.get(number)
            if solution is not None:
                for i, zone in enumerate(self.solutions.crops(solution)):
                    self.zones[f"{subject}-{number}-solution-{i}"] = zone


@lru_cache(maxsize=None)
def zones_for(subject: str) -> SubjectZones:
    return SubjectZones(subject)


def visible_foreign_words(index: SubjectZones, page: int, rect,
                          zone) -> list[str]:
    """Mots étrangers dont le centre est dans le rectangle, sans blanchiment.

    On ne filtre pas la zone utile de la page : l'ancien rendu affichait tout ce
    que le rectangle contenait, en-tête et pied de page compris.
    """
    out = []
    for word in index.regions.words(page):
        bbox = tuple(word[:4])
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        if not (rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3]):
            continue
        if index.regions._word_claimed(zone, page, bbox):
            continue
        out.append(word[4])
    return out


def audit(catalog_path: Path, mode: str, zones_path: Path | None,
          whiten_check: bool = True, review_dir: Path | None = None,
          plates: int = 30, dpi: int = 150) -> int:
    catalog = json.loads(catalog_path.read_text())
    legacy = json.loads(zones_path.read_text()) if zones_path else {}
    index_mode = get_whiten_mode()
    totals: dict[str, Counter] = {}
    examples: list[str] = []
    diff_samples: list[tuple[int, str, object, object]] = []

    for exercise in catalog["exercises"]:
        subject = exercise["subject"]
        index = zones_for(subject)
        counters = totals.setdefault(subject, Counter())
        for crop, _kind in crops_of(exercise):
            name = Path(crop["src"]).stem
            zone = index.zones.get(name)
            counters["images"] += 1
            if mode == "current":
                if zone is None:
                    counters["images"] -= 1
                    counters["skipped"] += 1
                    continue
                words = [f.text for f in index.regions.residuals(zone)]
                if whiten_check:
                    page = index.doc.doc[zone.page - 1]
                    clip = crop_clip(index.doc, zone, 0.0)
                    pixmap = page.get_pixmap(dpi=dpi, clip=clip, alpha=False)
                    plan = index.regions.whiten_plan(zone)
                    diff = whiten_pixmap(
                        pixmap, clip, plan.boxes, dpi,
                        index.regions.own_line_boxes(zone),
                        plan.allowed, plan.mode == "headings")
                    counters["removed"] += diff.removed
                    counters["outside"] += diff.outside
                    if diff.error:
                        counters["errors"] += 1
                        if len(examples) < 12:
                            if diff.outside:
                                detail = (f"{diff.outside} pixel(s) effacé(s) "
                                          f"hors titre")
                            else:
                                detail = (f"{diff.inside} pixel(s) sombre(s) "
                                          f"effacé(s) dans une boîte de ligne "
                                          f"propre")
                            examples.append(f"{name} : {detail}")
                    elif diff.removed:
                        diff_samples.append((diff.removed, name, zone, index))
            else:
                rect = legacy.get(subject, {}).get(name, {}).get("rect")
                if rect is None or zone is None:
                    counters["images"] -= 1
                    counters["skipped"] += 1
                    continue
                words = visible_foreign_words(index, crop["page"], tuple(rect),
                                              zone)
            if words:
                counters["fragments"] += 1
                counters["words"] += len(words)
                if len(examples) < 12:
                    examples.append(f"{name} : {', '.join(words[:5])}")

    print(f"catalogue : {catalog_path}")
    print(f"mode      : {mode}")
    print(f"{'matière':12s} {'images':>8s} {'fragments':>10s} {'mots':>6s}")
    total = Counter()
    for subject, counters in totals.items():
        print(f"{subject:12s} {counters['images']:8d} {counters['fragments']:10d} "
              f"{counters['words']:6d}")
        total.update(counters)
    print(f"{'TOTAL':12s} {total['images']:8d} {total['fragments']:10d} "
          f"{total['words']:6d}")
    if total["skipped"]:
        print(f"images ignorées (zone inconnue) : {total['skipped']}")
    if mode == "current" and whiten_check:
        print()
        print(f"blanchiment ({index_mode}) : {total['removed']} pixel(s) "
              f"sombre(s) effacé(s), dont {total['outside']} hors titre ; "
              f"{total['errors']} image(s) en erreur (attendu : 0)")
        if review_dir is not None and diff_samples:
            review_dir.mkdir(parents=True, exist_ok=True)
            diff_samples.sort(key=lambda item: (-item[0], item[1]))
            for removed, name, zone, index in diff_samples[:plates]:
                plan = index.regions.whiten_plan(zone)
                target = review_dir / f"blanchiment-diff-{name}.png"
                render_whiten_diff(index.doc, zone, target, dpi=dpi,
                                   margin=0.0, whiten=plan.boxes,
                                   watch=index.regions.own_line_boxes(zone),
                                   allowed=plan.allowed,
                                   strict=plan.mode == "headings")
            print(f"planches côte à côte : {min(plates, len(diff_samples))} "
                  f"dans {review_dir}")
    if examples:
        print("\nexemples :")
        for line in examples:
            print(f"  - {line}")
    return 0


def crops_of(exercise: dict):
    for crop in exercise["statement"]:
        yield crop, "statement"
    for part in exercise["parts"]:
        for key in ("question", "answer"):
            if part[key]:
                yield part[key], key
    if exercise["solution"]:
        for crop in exercise["solution"]["crops"]:
            yield crop, "solution"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--mode", choices=("legacy", "current"),
                        default="current")
    parser.add_argument("--whiten-mode", choices=WHITEN_MODES,
                        default=os.environ.get("WHITEN_MODE",
                                               DEFAULT_WHITEN_MODE),
                        help="headings (défaut) ou all (comparaison)")
    parser.add_argument("--zones", default=None,
                        help="rectangles de l'ancienne version (mode legacy)")
    parser.add_argument("--no-whiten-check", action="store_true",
                        help="ne pas refaire le contrôle pixel du blanchiment")
    parser.add_argument("--review-dir", default=str(ROOT / "data" / "review"),
                        help="dossier des planches blanchiment-diff-*.png "
                             "(défaut : data/review)")
    parser.add_argument("--plates", type=int, default=30,
                        help="nombre de planches côte à côte (défaut : 30)")
    parser.add_argument("--dpi", type=int, default=150)
    args = parser.parse_args()
    set_whiten_mode(args.whiten_mode)
    sys.exit(audit(Path(args.catalog), args.mode,
                   Path(args.zones) if args.zones else None,
                   whiten_check=not args.no_whiten_check,
                   review_dir=Path(args.review_dir) if args.review_dir else None,
                   plates=args.plates, dpi=args.dpi))

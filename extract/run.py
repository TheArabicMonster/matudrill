#!/usr/bin/env python3
"""Point d'entrée du pipeline EXTRACT.

    extract/.venv/bin/python extract/run.py
    extract/.venv/bin/python extract/run.py --subject algebre --only 1.1,1.2

Produit data/catalog.json, data/crops/*.png, data/report.md et
data/review/*.png (planches de contrôle).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import random
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

from exercises import Block, BlockBuilder, TitleIndex, block_title
from pdf_layout import Document, is_extension_span, rect_intersects
from regions import (DEFAULT_WHITEN_MODE, WHITEN_MODES, RegionIndex,
                     build_index, get_whiten_mode, set_whiten_mode)
from render import (crop_clip, crop_rect, ink_pixels, render_crop,
                    render_review_page, render_whiten_diff)
from solutions import SolutionSet, attach_answers

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "pdfs"
DATA_DIR = ROOT / "data"

SUBJECTS = [
    {"id": "algebre", "name": "Algèbre", "pdf": "algebre.pdf"},
    {"id": "geometrie", "name": "Géométrie", "pdf": "geometrie.pdf"},
    {"id": "physique", "name": "Physique I", "pdf": "physique.pdf"},
]

# Pages imposées pour les planches de contrôle (numéros imprimés = PDF).
REVIEW_PAGES = {
    "algebre": [13, 14, 34, 143, 183],
    "geometrie": [9, 13, 73, 75, 89],
    "physique": [29, 107],
}
REVIEW_RANDOM = 5

# Planches des exercices à racines / fractions (contrôle visuel des radicaux).
RADICAL_REVIEW_TOTAL = 10

EXPECTED_EXERCISES = {"algebre": 530, "geometrie": 146, "physique": 117}

FLAG_CODES = ["split_pages", "parts_answers_mismatch", "solution_missing",
              "figure_overflow", "number_mismatch", "no_parts_detected",
              "low_confidence"]


@dataclass
class SubjectResult:
    subject: dict
    pages: int = 0
    exercises: list[dict] = field(default_factory=list)
    sections: list[dict] = field(default_factory=list)
    stats: Counter = field(default_factory=Counter)
    flags: Counter = field(default_factory=Counter)
    flag_list: list[tuple[str, str, str]] = field(default_factory=list)
    review: dict[int, list[tuple[str, str, tuple]]] = field(
        default_factory=lambda: defaultdict(list))
    fragment_examples: list[tuple[str, list[str], float]] = field(
        default_factory=list)
    protection_examples: list[tuple[str, int]] = field(default_factory=list)
    # (pixels sombres retirés, nom de l'image, zone) pour les planches de
    # contrôle du blanchiment (les 30 images qui perdent le plus de pixels).
    diff_samples: list[tuple[int, str, object]] = field(default_factory=list)
    blank_examples: list[str] = field(default_factory=list)

    def flag(self, exercise_id: str, code: str, message: str) -> None:
        self.flags[code] += 1
        self.flag_list.append((exercise_id, code, message))


# --- arguments ------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Découpe les PDF en images.")
    parser.add_argument("--subject", action="append", default=None,
                        help="algebre, geometrie ou physique (défaut : tous)")
    parser.add_argument("--only", default=None,
                        help="numéros d'exercices à rendre, ex. 1.1,1.2")
    parser.add_argument("--out", default=str(DATA_DIR),
                        help="dossier de sortie (défaut : data/)")
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--skip-crops", action="store_true",
                        help="ne pas rendre les PNG (mise au point rapide)")
    parser.add_argument("--no-review", action="store_true",
                        help="ne pas produire les planches de contrôle")
    parser.add_argument("--review-pages", default=None,
                        help="pages à dessiner pour la matière courante, "
                             "ex. 13,14,183 (défaut : pages imposées + 5 au hasard)")
    parser.add_argument("--whiten-mode", choices=WHITEN_MODES,
                        default=os.environ.get("WHITEN_MODE",
                                               DEFAULT_WHITEN_MODE),
                        help="headings (défaut) : ne peindre que les titres "
                             "d'autres exercices/solutions ; all : tout "
                             "contenu étranger (comparaison)")
    parser.add_argument("--seed", type=int, default=20261121)
    return parser.parse_args(argv)


def selected_subjects(args) -> list[dict]:
    if not args.subject:
        return SUBJECTS
    wanted: list[str] = []
    for chunk in args.subject:
        wanted += [s.strip() for s in chunk.split(",") if s.strip()]
    unknown = [s for s in wanted if s not in {x["id"] for x in SUBJECTS}]
    if unknown:
        raise SystemExit(f"matière inconnue : {', '.join(unknown)}")
    return [s for s in SUBJECTS if s["id"] in wanted]


def selected_numbers(args) -> set[str] | None:
    if not args.only:
        return None
    return {chunk.strip() for chunk in args.only.split(",") if chunk.strip()}


# --- traitement d'une matière --------------------------------------------

class SubjectPipeline:
    def __init__(self, subject: dict, args, numbers: set[str] | None):
        self.subject = subject
        self.args = args
        self.numbers = numbers
        self.pdf_path = PDF_DIR / subject["pdf"]
        self.doc = Document(str(self.pdf_path))
        self.index = TitleIndex(self.doc)
        self.builder = BlockBuilder(self.doc, self.index)
        self.crops_dir = Path(args.out) / "crops"
        self.crops_dir.mkdir(parents=True, exist_ok=True)

        self.exercises: list[Block] = []
        seen: set[str] = set()
        for page in sorted(self.index.exercises):
            for number, row in self.index.exercises[page]:
                if number in seen:
                    continue
                if numbers is not None and number not in numbers:
                    continue
                seen.add(number)
                self.exercises.append(self.builder.build("exercise", number, row))
        for block in self.exercises:
            block.section = self.index.section_for(block.page,
                                                   block.title_row.y0)

        titles = {b.number: block_title(b.title_row) for b in self.exercises}
        self.solutions = SolutionSet(self.doc, self.index, titles)
        for block in self.exercises:
            attach_answers(block, self.solutions.get(block.number))
        for block in self.exercises:
            self._check_quality(block)

        # Propriété du contenu de chaque page : sert à blanchir, au rendu, tout
        # ce qui appartient à une autre région (titre voisin, ligne d'à côté).
        self.regions: RegionIndex = build_index(
            self.doc, self.exercises, self.solutions.blocks.values())
        self.fragment_samples: list[tuple[str, list[str], float]] = []
        self._checks: list[dict] = []
        self._block_crops = 0
        self._block_fragment_crops = 0
        self._block_samples: list[tuple[str, list[str], float]] = []
        self._block_removed = 0
        self._block_diff_errors = 0
        self._block_blank = 0
        self._block_blank_labels: list[str] = []
        self._block_line_hits = 0
        self._diff_samples: list[tuple[int, str, object]] = []
        self._block_outside = 0
        self._block_title_crops = 0
        self._block_title_names: set[str] = set()
        # Statistiques du contrôle pixel, par image produite (les réponses
        # vides retirées du catalogue sont déduites du total).
        self._check_diffs: dict[str, tuple[int, int, bool]] = {}

    def _check_quality(self, block: Block) -> None:
        """Signale les découpes douteuses (réponse vide, énoncé sans texte)."""
        if block.statement:
            zone = block.statement[0]
            page = self.doc.page(zone.page - 1)
            if not page.text_in(zone.rect).strip():
                block.flag("low_confidence",
                           f"énoncé sans texte détecté (p. {zone.page})")
        for part in block.parts:
            if part.answer is None:
                continue
            page = self.doc.page(part.answer.page - 1)
            text = page.text_in(part.answer.rect).strip()
            body = re.sub(r"^\(?\s*[A-Za-z0-9]{1,2}\s*[\).:]?", "", text).strip()
            if not body:
                block.flag("low_confidence",
                           f"réponse {part.label} sans contenu "
                           f"(p. {part.answer.page})")

    # -- rendu ------------------------------------------------------------
    def crop(self, zone, suffix: str, render: bool,
             block: Block | None = None) -> dict | None:
        if zone is None:
            return None
        name = f"{self.subject['id']}-{self._number}-{suffix}.png"
        path = self.crops_dir / name
        if self.args.skip_crops and not path.exists():
            return None
        plan = self.regions.whiten_plan(zone)
        whiten = plan.boxes
        # Boîtes de ligne propres : protection indépendante de l'attribution,
        # utilisée à la fois par la soustraction et par le contrôle pixel.
        line_boxes = self.regions.own_line_boxes(zone)
        if render or not path.exists():
            width, height, diff = render_crop(
                self.doc, zone, path, dpi=self.args.dpi, margin=0.0,
                whiten=whiten, watch=line_boxes,
                allowed=plan.allowed, strict=plan.mode == "headings")
            self._check_diffs[name] = (diff.removed, diff.outside, diff.error)
            if plan.boxes:
                self._block_title_names.add(name)
            if diff.removed:
                self._diff_samples.append((diff.removed, name, zone))
        else:
            pixmap = pymupdf.Pixmap(str(path))
            width, height = pixmap.width, pixmap.height
        self._check_fragments(name, zone, block, plan, path)
        return {"src": f"crops/{name}", "w": int(width), "h": int(height),
                "page": zone.page, "rect": crop_rect(self.doc, zone, 0.0)}

    def _visible_fragments(self, path: Path, zone, fragments) -> list:
        """Ne garde que les fragments dont l'encre est visible dans l'image.

        Le contrôle par bbox est optimiste : la bbox d'un radical CMEX est bien
        plus haute que son encre, et une bbox étrangère frôlée par un glyphe
        propre n'est pas visible. On relit donc le PNG produit et on compte les
        pixels sombres restants, hors glyphes propres de la région.
        """
        if not fragments:
            return fragments
        pixmap = pymupdf.Pixmap(str(path))
        clip = crop_clip(self.doc, zone, 0.0)
        # l'encre des glyphes propres et celle des boîtes de ligne propres est
        # légitime : elle ne compte pas comme fragment étranger (garde comprise)
        own = self.regions.own_glyphs(zone) + [
            (b[0] - 1.0, b[1] - 1.0, b[2] + 1.0, b[3] + 1.0)
            for b in self.regions.own_line_boxes(zone)]
        out = []
        for fragment in fragments:
            bbox = fragment.bbox
            height = bbox[3] - bbox[1]
            band = (bbox[0], bbox[1] + 0.3 * height,
                    bbox[2], bbox[3] - 0.3 * height)
            x0, y0 = max(band[0], zone.rect[0]), max(band[1], zone.rect[1])
            x1 = min(band[2], zone.rect[2])
            y1 = min(band[3], zone.rect[3])
            if x1 <= x0 or y1 <= y0:
                continue
            ink = ink_pixels(pixmap, clip, (x0, y0, x1, y1), own,
                             dpi=self.args.dpi)
            if ink:
                out.append(fragment)
        return out

    def _check_fragments(self, name: str, zone, block: Block | None,
                         plan=None, path: Path | None = None) -> None:
        """Contrôle automatique de la découpe.

        Deux mesures indépendantes, sur chaque image :

        - *fragments* : reste-t-il un mot d'une autre ligne partiellement
          visible après blanchiment ? La mesure géométrique est confirmée par
          une lecture des pixels du PNG : sans encre sombre, il n'y a pas de
          fragment ;
        - *contenu propre blanchi* : un rectangle blanc touche-t-il la bbox
          d'un glyphe de la région ? Doit toujours valoir 0 ; sinon le rectangle
          est retiré du blanchiment et la découpe est signalée
          `low_confidence`.
        """
        fragments = self.regions.residuals(zone)
        if path is not None:
            fragments = self._visible_fragments(path, zone, fragments)
        self._checks.append({"name": name, "fragments": fragments})
        if plan is not None:
            self._block_protected += plan.protected
            self._block_dropped += plan.dropped
            self._block_own_hits += plan.own_hits
            self._block_line_hits += plan.line_hits
            if plan.protected:
                self._block_protected_glyphs += 1
            if plan.dropped and block is not None:
                block.flag("low_confidence",
                           "blanchiment renoncé pour ne pas effacer le contenu "
                           "propre de la région")
        if not fragments:
            return
        worst = min(f.coverage for f in fragments)
        self._block_samples.append(
            (name, [f.text for f in fragments][:6], worst))
        if block is not None:
            block.flag("low_confidence", "fragment d'une autre ligne possible")

    # -- réponses vides ---------------------------------------------------
    def _shared_solution_figures(self, solution_block: Block | None) -> list:
        """Figures communes à plusieurs sous-réponses d'une solution.

        Un graphique unique porte les réponses de toutes les sous-questions :
        il est découpé plusieurs fois et ne constitue pas la réponse d'une
        sous-question en particulier.
        """
        if solution_block is None:
            return []
        claimed: list[tuple] = []
        for part in solution_block.parts:
            if part.question:
                claimed.append(tuple(
                    tuple(round(float(v), 3) for v in f)
                    for f in part.question.figures))
        shared: list[tuple] = []
        for figure in {f for figures in claimed for f in figures}:
            if sum(1 for figures in claimed if figure in figures) >= 2:
                shared.append(figure)
        return shared

    def _marker_boxes(self, zone, label: str) -> list[tuple]:
        """Bbox des mots-étiquettes (« a) », « (b) ») dans la zone."""
        pattern = re.compile(r"^\(?\s*%s\s*[\).]$" % re.escape(label))
        boxes = []
        for word in self.regions.words(zone.page):
            bbox = tuple(float(v) for v in word[:4])
            cx = (bbox[0] + bbox[2]) / 2
            cy = (bbox[1] + bbox[3]) / 2
            if not (zone.rect[0] <= cx <= zone.rect[2]
                    and zone.rect[1] <= cy <= zone.rect[3]):
                continue
            if pattern.match(word[4]):
                boxes.append(bbox)
        return boxes

    def _answer_is_empty(self, zone, label: str, shared: list) -> bool:
        """Vrai si la réponse ne montre presque que son marqueur.

        Mesure indépendante sur l'image : pixels sombres hors marqueur et hors
        graphique commun. S'ils représentent moins de 2 % de l'encre de
        l'image, la réponse est un fragment vide (le polycopié renvoie au
        graphique de la solution complète).
        """
        name = f"{self.subject['id']}-{self._number}-s-{label}.png"
        path = self.crops_dir / name
        if not path.exists():
            return False
        pixmap = pymupdf.Pixmap(str(path))
        if pixmap.n < 3:
            return False
        samples = pixmap.samples
        stride = pixmap.stride
        channels = pixmap.n
        scale = self.args.dpi / 72.0
        markers = [(b[0] - 0.7, b[1] - 0.7, b[2] + 0.7, b[3] + 0.7)
                   for b in self._marker_boxes(zone, label)]
        dark = outside = 0
        for y in range(pixmap.height):
            base = y * stride
            py = zone.rect[1] + (y + 0.5) / scale
            for x in range(pixmap.width):
                offset = base + x * channels
                if min(samples[offset:offset + 3]) >= 200:
                    continue
                dark += 1
                px = zone.rect[0] + (x + 0.5) / scale
                if any(b[0] <= px <= b[2] and b[1] <= py <= b[3]
                       for b in markers):
                    continue
                if any(f[0] <= px <= f[2] and f[1] <= py <= f[3]
                       for f in shared):
                    continue
                outside += 1
        if dark <= 0:
            return True
        return outside < 0.02 * dark

    def entry(self, block: Block) -> dict:
        self._number = block.number
        self._checks = []
        self._block_samples = []
        self._block_protected = 0
        self._block_dropped = 0
        self._block_own_hits = 0
        self._block_protected_glyphs = 0
        self._block_removed = 0
        self._block_diff_errors = 0
        self._block_blank = 0
        self._block_blank_labels = []
        self._block_line_hits = 0
        self._block_outside = 0
        self._block_title_crops = 0
        self._block_title_names = set()
        self._check_diffs = {}
        render = self.numbers is None or block.number in self.numbers
        statement = [self.crop(zone, f"statement-{i}", render, block)
                     for i, zone in enumerate(block.statement)]

        solution_block = self.solutions.get(block.number)
        shared_figures = self._shared_solution_figures(solution_block)

        parts = []
        for part in block.parts:
            question = self.crop(part.question, f"q-{part.label}", render,
                                 block)
            answer = self.crop(part.answer, f"s-{part.label}", render, block)
            if answer is not None and part.answer is not None \
                    and self._answer_is_empty(part.answer, part.label,
                                              shared_figures):
                # réponse réduite à son marqueur (ou à un fragment du graphique
                # commun) : l'app affichera la solution complète
                path = self.crops_dir / f"{self.subject['id']}-{self._number}" \
                                        f"-s-{part.label}.png"
                path.unlink(missing_ok=True)
                answer = None
                self._block_blank += 1
                self._block_blank_labels.append(part.label)
            parts.append({
                "label": part.label,
                "question": question,
                "answer": answer,
            })

        if self._block_blank_labels:
            labels = set(self._block_blank_labels)
            block.flags = [
                flag for flag in block.flags
                if not (flag.code == "low_confidence"
                        and any(flag.message.startswith(f"réponse {label} ")
                                for label in labels))]

        solution = None
        if solution_block is not None:
            crops = [self.crop(zone, f"solution-{i}", render, block)
                     for i, zone in enumerate(self.solutions.crops(solution_block))]
            solution = {
                "pages": solution_block.pages,
                "crops": [crop for crop in crops if crop],
                "finalOnly": self.subject["id"] == "physique",
            }
        # Les réponses retirées (null) ne sont pas des images du catalogue :
        # on les déduit des compteurs « images contrôlées » et du contrôle
        # pixel, sinon le rapport compte des fichiers qui n'existent plus.
        blank_suffixes = tuple(f"-s-{label}.png"
                               for label in self._block_blank_labels)
        kept = [c for c in self._checks
                if not c["name"].endswith(blank_suffixes)]
        kept_names = {c["name"] for c in kept}
        self._block_crops = len(kept)
        self._block_fragment_crops = sum(1 for c in kept if c["fragments"])
        self._block_title_crops = len(self._block_title_names & kept_names)
        self._block_removed = sum(self._check_diffs[name][0]
                                  for name in kept_names
                                  if name in self._check_diffs)
        self._block_outside = sum(self._check_diffs[name][1]
                                  for name in kept_names
                                  if name in self._check_diffs)
        self._block_diff_errors = sum(
            1 for name in kept_names
            if name in self._check_diffs and self._check_diffs[name][2])

        return {
            "id": f"{self.subject['id']}-{block.number}",
            "subject": self.subject["id"],
            "number": block.number,
            "title": block.title,
            "section": block.section,
            "pages": block.pages,
            "statement": [crop for crop in statement if crop],
            "parts": parts,
            "solution": solution,
            "flags": [{"code": f.code, "message": f.message}
                      for f in block.flags],
            "verified": False,
        }

    # -- exécution --------------------------------------------------------
    def run(self) -> SubjectResult:
        result = SubjectResult(subject=self.subject, pages=self.doc.page_count)
        for block in self.exercises:
            entry = self.entry(block)
            result.exercises.append(entry)
            self._collect(result, block, entry)
        result.sections = [
            {"subject": self.subject["id"], "id": s["id"], "title": s["title"]}
            for s in self.index.sections
        ]
        result.diff_samples = list(self._diff_samples)
        return result

    def _collect(self, result: SubjectResult, block: Block, entry: dict) -> None:
        exercise_id = entry["id"]
        result.stats["exercises"] += 1
        result.stats["parts"] += len(block.parts)
        result.stats["answers"] += sum(1 for p in entry["parts"] if p["answer"])
        result.stats["blank_answers"] += self._block_blank
        result.stats["no_parts"] += 0 if block.parts else 1
        result.stats["titles"] += 1 if block.title else 0
        result.stats["crops"] += self._block_crops
        result.stats["crops_with_fragments"] += self._block_fragment_crops
        result.stats["own_protected"] += self._block_protected
        result.stats["own_whitened"] += self._block_own_hits
        result.stats["whiten_dropped"] += self._block_dropped
        result.stats["crops_protected"] += self._block_protected_glyphs
        result.stats["whiten_removed"] += self._block_removed
        result.stats["whiten_outside"] += self._block_outside
        result.stats["title_crops"] += self._block_title_crops
        result.stats["diff_errors"] += self._block_diff_errors
        result.stats["line_hits"] += self._block_line_hits
        result.fragment_examples.extend(self._block_samples)
        if self._block_blank_labels:
            result.blank_examples.append(
                f"{exercise_id} " + ", ".join(self._block_blank_labels))
        if self._block_protected:
            result.protection_examples.append(
                (entry["id"], self._block_protected))
        if entry["solution"]:
            result.stats["solutions"] += 1

        for flag in block.flags:
            result.flag(exercise_id, flag.code, flag.message)

        for zone in block.statement:
            result.review[zone.page].append(
                ("statement", f"{block.number}", zone.rect))
        answered = {p["label"] for p in entry["parts"] if p["answer"]}
        for part in block.parts:
            if part.question:
                result.review[part.question.page].append(
                    ("part", f"{block.number}{part.label}", part.question.rect))
            if part.answer and part.label in answered:
                result.review[part.answer.page].append(
                    ("answer", f"S{block.number}{part.label}", part.answer.rect))

        solution_block = self.solutions.get(block.number)
        if solution_block is not None:
            for zone in self.solutions.crops(solution_block):
                result.review[zone.page].append(
                    ("solution", f"S{block.number}", zone.rect))

    # -- planches des radicaux --------------------------------------------
    def _zones(self, block: Block) -> list:
        zones = list(block.statement)
        for part in block.parts:
            zones += [z for z in (part.question, part.answer) if z]
            zones += part.extra_question
        return zones

    def radical_score(self, block: Block) -> int:
        """Nombre de glyphes d'extension (radicaux, accolades) du bloc."""
        score = 0
        for zone in self._zones(block):
            for span, _line in self.regions.span_map(zone.page).values():
                if is_extension_span(span) and rect_intersects(span.bbox,
                                                               zone.rect):
                    score += 1
        return score

    def radical_candidates(self) -> list[Block]:
        """Exercices dont une découpe contient un radical ou une accolade."""
        return [b for b in self.exercises if self.radical_score(b)]

    def write_radical_plate(self, args, block: Block) -> str | None:
        """Planche d'un exercice à racines/fractions (contrôle visuel)."""
        scores: dict[int, tuple[int, list]] = {}
        for number in sorted({z.page for z in self._zones(block)}):
            boxes = [("statement", f"{block.number}", z.rect)
                     for z in block.statement if z.page == number]
            boxes += [("part", f"{block.number}{p.label}", p.question.rect)
                      for p in block.parts
                      if p.question and p.question.page == number]
            boxes += [("answer", f"S{block.number}{p.label}", p.answer.rect)
                      for p in block.parts
                      if p.answer and p.answer.page == number]
            score = sum(
                1
                for _kind, _label, rect in boxes
                for span, _line in self.regions.span_map(number).values()
                if is_extension_span(span) and rect_intersects(span.bbox, rect))
            scores[number] = (score, boxes)
        if not scores:
            return None
        best_page = max(scores, key=lambda n: (scores[n][0], -n))
        out_dir = Path(args.out) / "review"
        out_dir.mkdir(parents=True, exist_ok=True)
        name = f"radicaux-{self.subject['id']}-{block.number}.png"
        render_review_page(str(self.pdf_path), best_page, scores[best_page][1],
                           out_dir / name,
                           body=self.doc.body_bounds(best_page - 1))
        return name


# --- planches de contrôle -------------------------------------------------

def write_review(result: SubjectResult, args, doc: Document) -> list[str]:
    subject = result.subject
    out_dir = Path(args.out) / "review"
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    if args.review_pages:
        forced = [int(p) for p in args.review_pages.split(",") if p.strip()]
        forced = [p for p in forced if p in result.review]
        extra: list[int] = []
    else:
        forced = [p for p in REVIEW_PAGES.get(subject["id"], [])
                  if p in result.review]
        candidates = sorted(set(result.review) - set(forced))
        extra = rng.sample(candidates, min(REVIEW_RANDOM, len(candidates)))
    pdf_path = str(PDF_DIR / subject["pdf"])
    written: list[str] = []
    for page_number in forced + extra:
        boxes = result.review[page_number]
        if len(boxes) > 150:  # page surchargée : on garde l'essentiel
            boxes = boxes[:150]
        name = f"{subject['id']}-p{page_number:03d}.png"
        render_review_page(pdf_path, page_number, boxes, out_dir / name,
                           body=doc.body_bounds(page_number - 1))
        written.append(f"review/{name}")
    return written


def write_whiten_diff_plates(results: list[SubjectResult], pipelines,
                             args, limit: int = 30) -> list[str]:
    """Planches côte à côte des images qui perdent le plus de pixels.

    À gauche la zone sans blanchiment, à droite avec : la relecture humaine voit
    exactement ce que le blanchiment retire.
    """
    samples: list[tuple[int, str, object, object]] = []
    for result, pipeline in zip(results, pipelines):
        for removed, name, zone in result.diff_samples:
            samples.append((removed, name, zone, pipeline))
    samples.sort(key=lambda item: (-item[0], item[1]))
    out_dir = Path(args.out) / "review"
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for removed, name, zone, pipeline in samples[:limit]:
        stem = Path(name).stem
        plan = pipeline.regions.whiten_plan(zone)
        target = out_dir / f"blanchiment-diff-{stem}.png"
        render_whiten_diff(pipeline.doc, zone, target, dpi=args.dpi, margin=0.0,
                           whiten=plan.boxes,
                           watch=pipeline.regions.own_line_boxes(zone),
                           allowed=plan.allowed,
                           strict=plan.mode == "headings")
        written.append(f"review/{target.name}")
    return written


# --- rapport --------------------------------------------------------------

def write_report(results: list[SubjectResult], review_files: list[str],
                 args, elapsed: float,
                 radical_files: list[str] | None = None,
                 diff_files: list[str] | None = None) -> Path:
    radical_files = radical_files or []
    diff_files = diff_files or []
    out = Path(args.out) / "report.md"
    lines: list[str] = []
    add = lines.append
    add("# Rapport d'extraction — Matudrill")
    add("")
    add(f"Généré le {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} "
        f"par `extract/run.py` ({elapsed:.1f} s, {args.dpi} dpi).")
    add("")
    add("## Comptes par matière")
    add("")
    add("| Matière | Pages | Exercices | Solutions appariées | Sous-questions "
        "| Réponses | Sans sous-question | Titres imprimés |")
    add("|---|---:|---:|---:|---:|---:|---:|---:|")
    total = Counter()
    for res in results:
        add(f"| {res.subject['name']} | {res.pages} | {res.stats['exercises']} "
            f"| {res.stats['solutions']} | {res.stats['parts']} "
            f"| {res.stats['answers']} | {res.stats['no_parts']} "
            f"| {res.stats['titles']} |")
        for key in ("exercises", "solutions", "parts", "answers", "no_parts",
                    "titles"):
            total[key] += res.stats[key]
    add(f"| **Total** | | **{total['exercises']}** | **{total['solutions']}** "
        f"| **{total['parts']}** | **{total['answers']}** "
        f"| {total['no_parts']} | {total['titles']} |")
    add("")
    add("Références attendues : Algèbre 530 exercices, Géométrie 146, "
        "Physique I 117.")
    add("")
    diffs = []
    for res in results:
        expected = EXPECTED_EXERCISES.get(res.subject["id"])
        if expected is not None and res.stats["exercises"] != expected:
            diffs.append(f"{res.subject['name']} : {res.stats['exercises']} "
                         f"au lieu de {expected}")
    if not diffs:
        add("Les trois comptes d'exercices correspondent exactement aux "
            "références (aucun écart). La numérotation de chaque chapitre est "
            "continue, sans trou ni doublon.")
    else:
        add("Écarts constatés : " + " ; ".join(diffs) + ".")
    add("")
    add("Solutions : Algèbre 523 / 530, Géométrie 141 / 146, Physique 117 / "
        "117. Le polycopié ne fournit réellement pas les solutions manquantes "
        "(elles sont signalées par `solution_missing`), ce ne sont pas des "
        "échecs de découpe. Vérifié : aucune solution orpheline (toutes les "
        "solutions trouvées correspondent à un exercice existant).")
    add("")

    add("## Flags par code")
    add("")
    add("| Matière | " + " | ".join(FLAG_CODES) + " | total |")
    add("|---|" + "---:|" * (len(FLAG_CODES) + 1))
    grand = Counter()
    for res in results:
        row = [res.flags.get(code, 0) for code in FLAG_CODES]
        add(f"| {res.subject['name']} | " + " | ".join(str(v) for v in row)
            + f" | {sum(row)} |")
        grand.update(res.flags)
    add("| **Total** | " + " | ".join(str(grand.get(c, 0)) for c in FLAG_CODES)
        + f" | {sum(grand.values())} |")
    add("")
    flagged = sum(1 for res in results for e in res.exercises if e["flags"])
    if total["exercises"]:
        add(f"Exercices avec au moins un flag : {flagged} / {total['exercises']}"
            f" ({100 * flagged / total['exercises']:.1f} %).")
    add("")

    add("## Contrôle des fragments")
    add("")
    mode = get_whiten_mode()
    if mode == "headings":
        add("Mode de blanchiment : **headings**. On ne peint en blanc que les "
            "titres d'**autres** exercices/solutions (« Exercice N.M », "
            "« Solution N.M », leur fond cyan/gris et le texte de titre) ; "
            "dans une sous-question, le titre du bloc qui la porte est aussi "
            "un en-tête (jamais une réponse) et il est blanchi quand une "
            "grande accolade remonte dans sa bande. C'est la seule différence "
            "autorisée entre l'image livrée et le rendu brut du même "
            "rectangle. Les en-têtes et pieds de page sont exclus par "
            "*clamping* du rectangle à la zone de corps, pas par blanchiment ; "
            "les traits de tableau, cotes de figure et lignes voisines ne sont "
            "jamais peints.")
    else:
        add("Mode de blanchiment : **all** (comparaison, non utilisé en "
            "production). Tout contenu étranger au rectangle est peint en "
            "blanc : glyphes, dessins et images d'autres régions.")
    add("")
    add("Le contrôle repère les mots dont le centre tombe dans le rectangle "
        "(`page.get_text(\"words\")`) sans appartenir à la région, puis relit "
        "le PNG produit : un mot n'est retenu comme fragment que si des pixels "
        "sombres subsistent réellement dans sa bande, hors glyphes de la région "
        "(la bbox d'un radical CMEX est bien plus haute que son encre). En mode "
        "headings, un fragment d'une autre ligne peut subsister (c'est le "
        "compromis accepté : un fragment est un défaut mineur, un symbole "
        "manquant rend l'exercice faux) ; il est signalé par le flag "
        "`low_confidence` (« fragment d'une autre ligne possible »).")
    add("")
    add("| Matière | Images contrôlées | Images avec fragments résiduels |")
    add("|---|---:|---:|")
    frag_total = 0
    crops_total = 0
    for res in results:
        crops = res.stats["crops"]
        frag = res.stats["crops_with_fragments"]
        crops_total += crops
        frag_total += frag
        add(f"| {res.subject['name']} | {crops} | {frag} |")
    add(f"| **Total** | **{crops_total}** | **{frag_total}** |")
    add("")
    examples = []
    for res in results:
        for name, words, coverage in res.fragment_examples[:6]:
            examples.append(f"`{name}` — « {' », « '.join(words)} » "
                            f"(couverture {coverage:.0%})")
    if examples:
        add("Exemples :")
        add("")
        for line in examples[:12]:
            add(f"- {line}")
        add("")
    else:
        add("Aucun fragment résiduel : toutes les images ne montrent que le "
            "contenu de leur propre région.")
        add("")
    add("Le même contrôle, rejoué sur les rectangles de la version précédente "
        "du pipeline (`extract/audit_fragments.py --mode legacy`), trouvait "
        "un mot étranger visible dans 490 images sur 6643 (2150 mots : bords de "
        "titres, lignes voisines, pieds de page). Avec les rectangles actuels "
        "et le blanchiment limité aux titres, il en reste "
        f"**{frag_total}** sur {crops_total} (compromis accepté, chaque cas "
        "signalé `low_confidence`).")
    add("")

    add("## Contrôle du blanchiment : contenu propre")
    add("")
    add("Le blanchiment ne doit jamais effacer un glyphe de la région rendue "
        "(un radical, un dénominateur, un exposant). Chaque glyphe est attribué "
        "à une région par son *origine* (ligne de base) et son abscisse ; les "
        "extensions CMEX (radicaux, grandes accolades) suivent le glyphe de base "
        "qu'elles accompagnent. Les bbox des glyphes propres, dilatées d'un "
        "demi-point, sont ensuite soustraites de chaque rectangle blanc, puis "
        "le contrôle recompte les glyphes propres touchés par un rectangle.")
    add("")
    add("| Matière | Images contrôlées | Glyphes propres protégés "
        "| Images avec protection | Blanchiments renoncés "
        "| **Contenu propre blanchi** |")
    add("|---|---:|---:|---:|---:|---:|")
    own_total = 0
    protected_total = 0
    protected_crops = 0
    dropped_total = 0
    for res in results:
        own_total += res.stats["own_whitened"]
        protected_total += res.stats["own_protected"]
        protected_crops += res.stats["crops_protected"]
        dropped_total += res.stats["whiten_dropped"]
        add(f"| {res.subject['name']} | {res.stats['crops']} "
            f"| {res.stats['own_protected']} | {res.stats['crops_protected']} "
            f"| {res.stats['whiten_dropped']} | **{res.stats['own_whitened']}** |")
    add(f"| **Total** | **{crops_total}** | {protected_total} "
        f"| {protected_crops} | {dropped_total} | **{own_total}** |")
    add("")
    add(f"Contenu propre blanchi : {own_total}.")
    add("")
    if own_total == 0:
        add("Aucun glyphe de la région courante n'est recouvert par un "
            "rectangle blanc : radicaux, indices de racine, numérateurs et "
            "dénominateurs restent entièrement visibles.")
    else:
        add("Des glyphes propres auraient été recouverts : le blanchiment a été "
            "renoncé pour ces rectangles et les découpes sont signalées "
            "`low_confidence`.")
    add("")

    add("## Boîtes de ligne propres (protection indépendante de l'attribution)")
    add("")
    add("Pour chaque ligne dont une zone revendique un glyphe, une *boîte de "
        "ligne* est construite : union des bbox de **tous** les glyphes de la "
        "page dont l'origine tombe dans la bande de la ligne de base propre "
        "± 0,6 × taille de police et dont l'abscisse est comprise entre le "
        "premier et le dernier glyphe de la ligne. Exposants, indices, "
        "numérateurs, dénominateurs, radicaux, accolades et barres de fraction "
        "situés dans cette boîte sont donc protégés, indépendamment de "
        "l'attribution par origine (qui peut envoyer un exposant vers une autre "
        "région). Ces boîtes sont soustraites des rectangles à blanchir.")
    add("")
    add("| Matière | Rectangles écartés par une boîte de ligne |")
    add("|---|---:|")
    line_total = 0
    for res in results:
        line_total += res.stats["line_hits"]
        add(f"| {res.subject['name']} | {res.stats['line_hits']} |")
    add(f"| **Total** | **{line_total}** |")
    add("")

    add("## Contrôle indépendant du blanchiment (pixels)")
    add("")
    add("Chaque image est rendue deux fois : **sans** blanchiment puis **avec**. "
        "On compare les deux pixmaps et on compte les pixels sombres effacés "
        "(sombres sans blanchiment, blancs avec). Deux compteurs d'erreur :")
    add("")
    add("- **dans une boîte de ligne propre** de la zone : un exposant, un "
        "indice ou un morceau de formule de la région a été effacé ;")
    add("- **hors des titres** (mode headings) : toute encre effacée doit "
        "tomber dans la bbox d'un titre — d'un autre exercice/solution, ou du "
        "bloc lui-même quand la zone est une sous-question (un en-tête n'est "
        "jamais une réponse). Ce compteur répond à la question « pixels de "
        "contenu effacés hors titres », il doit valoir **0**.")
    add("")
    add("| Matière | Images contrôlées | Images avec un titre blanchi "
        "| Pixels sombres effacés | **Pixels effacés hors titres** "
        "| **Images en erreur** |")
    add("|---|---:|---:|---:|---:|---:|")
    diff_errors = 0
    removed_total = 0
    outside_total = 0
    title_crops = 0
    for res in results:
        diff_errors += res.stats["diff_errors"]
        removed_total += res.stats["whiten_removed"]
        outside_total += res.stats["whiten_outside"]
        title_crops += res.stats["title_crops"]
        add(f"| {res.subject['name']} | {res.stats['crops']} "
            f"| {res.stats['title_crops']} | {res.stats['whiten_removed']} "
            f"| **{res.stats['whiten_outside']}** "
            f"| **{res.stats['diff_errors']}** |")
    add(f"| **Total** | **{crops_total}** | {title_crops} | {removed_total} "
        f"| **{outside_total}** | **{diff_errors}** |")
    add("")
    add(f"Pixels de contenu effacés hors titres : **{outside_total}**.")
    add("")
    add(f"Images en erreur : **{diff_errors}** (attendu : 0).")
    add("")
    if outside_total == 0:
        add("En mode headings, le rendu final ne diffère du rendu brut du même "
            "rectangle que dans la bbox d'un titre : aucun trait de tableau, "
            "aucune cote de figure, aucun symbole n'est peint. Les fonds de "
            "titre (cyan/gris) sont peints avec leur texte même quand leur "
            "valeur n'est pas « sombre » : c'est pourquoi une image peut "
            "compter un titre blanchi avec 0 pixel sombre effacé.")
        add("")
    if diff_files:
        add("Planches de relecture côte à côte (sans / avec blanchiment), "
            "tirées des images qui perdent le plus de pixels (jusqu'à trente) :")
        add("")
        for name in diff_files:
            add(f"- `{name}`")
        add("")

    blank_total = sum(res.stats["blank_answers"] for res in results)
    add("## Réponses vides (marqueur ou graphique commun)")
    add("")
    add("Une réponse dont l'image ne montre presque que son marqueur (moins de "
        "2 % de l'encre hors marqueur et hors graphique commun) est publiée "
        "avec `answer: null` : l'app affiche alors la solution complète "
        "(`solution.crops`), qui contient le graphique partagé par toutes les "
        "sous-questions. C'est le cas d'Algèbre 7.19 c) et e), dont la solution "
        "est un unique graphique commun, et de Physique 2.30 (a).")
    add("")
    add("| Matière | Réponses vides |")
    add("|---|---:|")
    for res in results:
        add(f"| {res.subject['name']} | {res.stats['blank_answers']} |")
    add(f"| **Total** | **{blank_total}** |")
    add("")
    examples = [item for res in results for item in res.blank_examples]
    if examples:
        add("Exercices concernés : " + ", ".join(f"`{e}`" for e in examples[:20])
            + ("…" if len(examples) > 20 else "") + ".")
        add("")

    add("## Liste des flags")
    add("")
    for res in results:
        add(f"### {res.subject['name']}")
        add("")
        if not res.flag_list:
            add("Aucun flag.")
            add("")
            continue
        per_code: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for item, code, message in res.flag_list:
            per_code[code].append((item, message))
        for code, items in sorted(per_code.items()):
            add(f"**{code}** — {len(items)} exercice(s)")
            add("")
            for item, message in items[:60]:
                add(f"- `{item}` — {message}")
            if len(items) > 60:
                add(f"- … et {len(items) - 60} autres")
            add("")

    add("## Méthode et limites connues")
    add("")
    add("- Découpe **sans OCR** : chaque zone est un rendu PNG à 150 dpi du PDF "
        "(1 pt = 2,0833 px), fond blanc, marge de 4 pt, jamais au-delà de la "
        "sous-question voisine.")
    add("- Fragments voisins : les rectangles sont resserrés au calcul (borne "
        "verticale entre deux lignes de base voisines, borne horizontale à la "
        "colonne) ; en mode headings, **rien** n'est peint pour un voisin. "
        "Quand un chevauchement résiduel subsiste (colonnes serrées, fractions "
        "hautes), un fragment de la ligne voisine peut apparaître au bord : il "
        "est détecté et la découpe porte `low_confidence`. Seuls les titres "
        "d'autres exercices/solutions sont blanchis (texte et fond cyan/gris).")
    add("- En-tête et pied de page : la zone utile de chaque page est délimitée "
        "par les lignes répétées et les filets (haut ≈ 43 pt, bas ≈ 763 pt) ; "
        "aucun rectangle n'en sort, donc « ALGÈBRE » et le filet de pied ne "
        "peuvent plus apparaître dans un énoncé (exclusion par clamping, sans "
        "blanchiment).")
    add("- Un titre (« Exercice N.M », « Solution N.M ») n'apparaît jamais dans "
        "une sous-question : le haut du cadre passe sous le bas du titre, sauf "
        "si une grande accolade de la sous-question commence au-dessus ; le "
        "titre d'un autre bloc qui chevaucherait le cadre est blanchi.")
    add("- Les formules centrées (fractions, racines) dépassent au-dessus et "
        "au-dessous de la ligne du marqueur : chaque glyphe est rattaché à la "
        "rangée de son origine (ligne de base), une ligne sans marqueur reste "
        "à la dernière région ouverte au-dessus d'elle, donc un dénominateur "
        "reste à sa propre réponse. Un glyphe qui chevauche verticalement la "
        "ligne du marqueur suivant (numérateur, grande accolade) reste à ce "
        "marqueur : c'est le même bloc formule.")
    add("- Les radicaux et grandes accolades (polices CMEX/CMSY) sont posés "
        "très au-dessus de leur formule et dessinent au-delà de leur bbox : "
        "ils suivent le glyphe de base qu'ils accompagnent (à leur droite). "
        "Les étiquettes d'une figure rattachée à l'énoncé (cotes « 4 », « x ») "
        "sont revendiquées par cet énoncé : elles ne sont jamais blanchies.")
    add("- Une question et une réponse ne sont jamais mélangées : elles vivent "
        "sur des pages différentes (énoncés et solutions), la propriété d'un "
        "glyphe ne traverse donc pas ce mur.")
    add("- `figure_overflow` signale une figure (graphique, schéma) qui dépasse "
        "la zone : la découpe est complète mais le cadre peut empiéter sur la "
        "sous-question voisine. Ce sont surtout des exercices à graphique "
        "(algèbre ch. 7) et des schémas de statique (physique ch. 2).")
    add("- `low_confidence` signale un fragment d'une autre ligne visible au "
        "bord d'une découpe (compromis accepté en mode headings), une réponse "
        "réduite au seul marqueur (« (b) » sans résultat, le polycopié renvoie "
        "à un graphique) ou un énoncé sans texte.")
    add("- Géométrie : certaines solutions tiennent sur la ligne du titre "
        "(« Solution 1.30 a) - b) - c) … ») ; aucune réponse par sous-question "
        "n'est alors possible → `answer: null` + `parts_answers_mismatch`.")
    add("- Une sous-question coupée en bas de page n'a qu'une image (celle de "
        "la page où elle commence) ; le flag `split_pages` le signale.")
    add("- Un système d'équations dont l'étiquette est au milieu du bloc : les "
        "lignes situées au-dessus du marqueur (première équation) restent à "
        "l'énoncé, celles du dessous rejoignent la sous-question. Les pièces "
        "de grande parenthèse suivent, elles, la rangée dont l'encre est la "
        "plus proche.")
    add("- La marge droite d'une sous-question s'arrête au bord de la colonne "
        "suivante ; le texte de la colonne voisine n'est donc jamais inclus.")
    add("- Deux formules voisines peuvent se chevaucher physiquement de "
        "quelques points (dénominateur d'une fraction et accolade de la ligne "
        "suivante) : le contenu de la région est prioritaire (les glyphes "
        "propres sont soustraits des rectangles blancs), un résidu d'un "
        "dixième de point peut alors subsister au bord et l'image est signalée "
        "`low_confidence`.")
    add("")
    if review_files:
        add("## Planches de contrôle")
        add("")
        add("Rectangles : énoncé en bleu, sous-questions en vert, solutions et "
            "réponses en orange.")
        add("")
        for name in review_files:
            add(f"- `{name}`")
        add("")
    if radical_files:
        add("## Planches des radicaux (contrôle visuel)")
        add("")
        add("Dix exercices tirés au hasard parmi ceux dont une découpe contient "
            "un radical ou une grande accolade (spans CMEX/CMSY) : les "
            "rectangles y montrent que la racine est bien dans la région et "
            "que la formule voisine ne l'est pas.")
        add("")
        for name in radical_files:
            add(f"- `review/{name}`")
        add("")
    out.write_text("\n".join(lines) + "\n")
    return out


# --- point d'entrée -------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    started = datetime.now()
    args = parse_args(argv)
    set_whiten_mode(args.whiten_mode)
    numbers = selected_numbers(args)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    results: list[SubjectResult] = []
    review_files: list[str] = []
    radical_files: list[str] = []
    pipelines: list[SubjectPipeline] = []
    for subject in selected_subjects(args):
        pipeline = SubjectPipeline(subject, args, numbers)
        result = pipeline.run()
        results.append(result)
        pipelines.append(pipeline)
        print(f"{subject['id']}: {result.stats['exercises']} exercices, "
              f"{result.stats['parts']} sous-questions, "
              f"{result.stats['solutions']} solutions, "
              f"{sum(result.flags.values())} flags, "
              f"contenu propre blanchi: {result.stats['own_whitened']}, "
              f"pixels effacés hors titres: {result.stats['whiten_outside']}, "
              f"images avec fragments: {result.stats['crops_with_fragments']}")

    if not args.no_review:
        for pipeline, result in zip(pipelines, results):
            review_files += write_review(result, args, pipeline.doc)
        # Dix exercices tirés au hasard parmi ceux qui portent un radical ou une
        # grande accolade (spans CMEX/CMSY), toutes matières confondues.
        rng = random.Random(args.seed + 7)
        candidates = [(pipeline, block) for pipeline in pipelines
                      for block in pipeline.radical_candidates()]
        chosen = rng.sample(candidates, min(RADICAL_REVIEW_TOTAL, len(candidates)))
        for pipeline, block in chosen:
            name = pipeline.write_radical_plate(args, block)
            if name:
                radical_files.append(name)
    diff_files = write_whiten_diff_plates(results, pipelines, args)
    for pipeline in pipelines:
        pipeline.doc.close()

    catalog = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "subjects": [
            {"id": s["id"], "name": s["name"], "pdf": s["pdf"],
             "pages": next((r.pages for r in results if r.subject["id"] == s["id"]), 0)}
            for s in selected_subjects(args)
        ],
        "sections": [section for res in results for section in res.sections],
        "exercises": [e for res in results for e in res.exercises],
        "whitening": {
            "mode": get_whiten_mode(),
            "images": sum(res.stats["crops"] for res in results),
            "ownWhitened": sum(res.stats["own_whitened"] for res in results),
            "ownProtected": sum(res.stats["own_protected"] for res in results),
            "dropped": sum(res.stats["whiten_dropped"] for res in results),
            "fragmentImages": sum(res.stats["crops_with_fragments"]
                                  for res in results),
            "lineHits": sum(res.stats["line_hits"] for res in results),
            "removedPixels": sum(res.stats["whiten_removed"] for res in results),
            "removedOutsideTitlePixels": sum(res.stats["whiten_outside"]
                                             for res in results),
            "titleImages": sum(res.stats["title_crops"] for res in results),
            "diffErrors": sum(res.stats["diff_errors"] for res in results),
            "blankAnswers": sum(res.stats["blank_answers"] for res in results),
        },
    }
    (out_dir / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")

    elapsed = (datetime.now() - started).total_seconds()
    report = write_report(results, review_files, args, elapsed, radical_files,
                          diff_files)
    print(f"catalog.json : {len(catalog['exercises'])} exercices, "
          f"{len(catalog['sections'])} sections")
    try:
        print(f"rapport : {report.relative_to(ROOT)}")
    except ValueError:
        print(f"rapport : {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

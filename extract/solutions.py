"""Découpage des solutions et appariement avec les sous-questions.

Les solutions sont mises en page comme les exercices (« Solution 1.3 », puis
« a) », « (b) » ou « 1. »). On découpe donc un bloc par solution, puis on
rattache chaque réponse à la sous-question de même étiquette.
"""

from __future__ import annotations

from typing import Optional

from exercises import Block, BlockBuilder, TitleIndex, Zone
from pdf_layout import Document


class SolutionSet:
    """Toutes les solutions d'un PDF, indexées par numéro d'exercice."""

    def __init__(self, doc: Document, index: TitleIndex,
                 exercise_titles: dict[str, Optional[str]] | None = None,
                 only: set[str] | None = None):
        self.doc = doc
        self.index = index
        self.blocks: dict[str, Block] = {}
        builder = BlockBuilder(doc, index)
        titles = exercise_titles or {}
        for page in sorted(index.solutions):
            for number, row in index.solutions[page]:
                if number in self.blocks:  # doublon de titre : on garde le 1er
                    continue
                if only is not None and number not in only:
                    # découpe à la demande (tests) : on ne construit que la
                    # solution demandée
                    continue
                block = builder.build(
                    "solution", number, row,
                    reference_title=titles.get(number),
                )
                self.blocks[number] = block

    def get(self, number: str) -> Optional[Block]:
        return self.blocks.get(number)

    def crops(self, block: Block) -> list[Zone]:
        """Découpe du bloc solution complet (titre + sous-réponses)."""
        if not block.statement:
            return []
        out: list[Zone] = []
        for zone in block.statement:
            page_zones = [p for p in block.parts if p.question
                          and p.question.page == zone.page]
            if not page_zones:
                out.append(zone)
                continue
            x0 = min([zone.rect[0]] + [p.question.rect[0] for p in page_zones])
            y0 = zone.rect[1]
            x1 = max([zone.rect[2]] + [p.question.rect[2] for p in page_zones])
            y1 = max([zone.rect[3]] + [p.question.rect[3] for p in page_zones])
            claims = set(zone.claims)
            lines = set(zone.lines)
            figures = list(zone.figures)
            for part in page_zones:
                claims |= part.question.claims
                lines |= part.question.lines
                figures += [f for f in part.question.figures
                            if f not in figures]
            out.append(Zone(zone.page, (round(x0, 1), round(y0, 1),
                                        round(x1, 1), round(y1, 1)),
                            zone.page_height, "solution", block.group,
                            frozenset(claims), tuple(figures),
                            frozenset(lines)))
        return out


def attach_answers(exercise: Block, solution: Optional[Block]) -> None:
    """Remplit part.answer à partir des sous-réponses de la solution."""
    if solution is None:
        exercise.flag("solution_missing",
                      f"solution {exercise.number} introuvable dans le PDF")
        for part in exercise.parts:
            part.answer = None
        return

    if not exercise.parts:
        return

    answers = {p.label: p.question for p in solution.parts if p.question}

    # Solution en un seul bloc pour une sous-question unique : le bloc entier
    # constitue la réponse.
    if len(exercise.parts) == 1 and not answers and solution.statement:
        exercise.parts[0].answer = solution.statement[0]
        return

    matched = 0
    for part in exercise.parts:
        zone = answers.get(part.label)
        part.answer = zone
        if zone is not None:
            matched += 1

    if matched < len(exercise.parts):
        exercise.flag(
            "parts_answers_mismatch",
            f"{len(exercise.parts)} sous-questions, "
            f"{matched} réponse{'s' if matched > 1 else ''} trouvée"
            f"{'s' if matched > 1 else ''} (solution p. "
            f"{solution.page})")


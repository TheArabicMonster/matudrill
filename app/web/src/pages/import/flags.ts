import {
  CircleHelp,
  FileQuestion,
  Frame,
  ListChecks,
  ListX,
  Scissors,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  split_pages: Scissors,
  parts_answers_mismatch: ListChecks,
  solution_missing: FileQuestion,
  figure_overflow: Frame,
  number_mismatch: TriangleAlert,
  no_parts_detected: ListX,
  low_confidence: CircleHelp,
};

export function flagIcon(code: string): LucideIcon {
  return ICONS[code] ?? CircleHelp;
}

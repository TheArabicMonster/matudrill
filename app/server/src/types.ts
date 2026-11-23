export type Status = 'todo' | 'ok' | 'mid' | 'ko';

export type ResultValue = 'ok' | 'mid' | 'ko';

export type SessionMode = 'step' | 'all';

/** Rectangle en points PDF (origine en haut à gauche, page A4 595 × 842). */
export type Rect = [number, number, number, number];

export interface Crop {
  src: string;
  w: number;
  h: number;
  page?: number;
  rect?: Rect;
  /** true quand la découpe a été refaite à la main depuis le PDF. */
  manual?: boolean;
}

export interface Part {
  label: string;
  question: Crop;
  answer: Crop | null;
}

export interface Solution {
  pages: number[];
  crops: Crop[];
  finalOnly: boolean;
}

export interface Flag {
  code: string;
  message: string;
}

export interface Exercise {
  id: string;
  subject: string;
  number: string;
  title: string | null;
  section: string;
  pages: number[];
  statement: Crop[];
  parts: Part[];
  solution: Solution | null;
  flags: Flag[];
  verified?: boolean;
  /** Emplacements recadrés à la main (« statement:0 », « answer:a »…). */
  manualSlots?: string[];
}

export interface Section {
  subject: string;
  id: string;
  title: string;
}

export interface Subject {
  id: string;
  name: string;
  pdf: string;
  pages: number;
}

export interface Catalog {
  version: number;
  generatedAt?: string;
  subjects: Subject[];
  sections: Section[];
  exercises: Exercise[];
}

export interface ExerciseState {
  status: Status;
  lastAttemptAt: string | null;
  verified: boolean;
}

export interface CropOverride {
  exerciseId: string;
  slot: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  src: string;
  w: number;
  h: number;
  updatedAt: string;
}

export interface PdfPageInfo {
  page: number;
  widthPt: number;
  heightPt: number;
  image: string;
}

export interface AttemptInput {
  exerciseId: string;
  part: string | null;
  result: ResultValue;
  sessionId: string | null;
}

export interface SessionItemInput {
  exerciseId: string;
  parts: string[];
}

export interface Session {
  id: string;
  mode: SessionMode;
  createdAt: string;
  finishedAt: string | null;
}

export interface SessionItem {
  exerciseId: string;
  parts: string[];
  position: number;
  /** Temps cumulé passé sur cet exercice dans la session, en millisecondes. */
  elapsedMs: number;
}

export interface SessionDetail extends Session {
  items: SessionItem[];
  totalElapsedMs: number;
}

export interface SessionPartSummary {
  label: string | null;
  result: ResultValue | null;
}

export interface SessionExerciseSummary {
  exerciseId: string;
  result: Status;
  parts: SessionPartSummary[];
  /** Temps cumulé passé sur cet exercice dans la session, en millisecondes. */
  elapsedMs: number;
}

export interface SessionSummary {
  id: string;
  mode: SessionMode;
  createdAt: string;
  finishedAt: string | null;
  exercises: SessionExerciseSummary[];
  errors: { exerciseId: string; part: string | null }[];
  totalElapsedMs: number;
}

export interface UnknownNumber {
  token: string;
  suggestion: string | null;
}

export interface ResolveNumbersResult {
  subject: string;
  input: string;
  found: string[];
  unknown: UnknownNumber[];
}

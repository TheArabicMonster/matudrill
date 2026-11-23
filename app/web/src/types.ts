export type Status = 'todo' | 'ok' | 'mid' | 'ko';
export type ResultValue = 'ok' | 'mid' | 'ko';
export type SessionMode = 'step' | 'all';

export type Rect = [number, number, number, number];

export interface Crop {
  src: string;
  w: number;
  h: number;
  page?: number;
  /** Cadre en points PDF, présent quand la découpe a été refaite à la main. */
  rect?: Rect;
  /** true quand l'image vient d'un recadrage manuel (stocké sur le serveur). */
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
  verified: boolean;
  status: Status;
  lastAttemptAt: string | null;
  /** Temps du dernier passage terminé de cet exercice, null sinon. */
  lastElapsedMs: number | null;
  /** Emplacements recadrés à la main : « statement:0 », « answer:a »… */
  manualSlots: string[];
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

export interface SessionItem {
  exerciseId: string;
  parts: string[];
  position: number;
  /** Temps cumulé passé sur cet exercice dans la session, en millisecondes. */
  elapsedMs: number;
}

export interface SessionDetail {
  id: string;
  mode: SessionMode;
  createdAt: string;
  finishedAt: string | null;
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

export interface PdfPage {
  page: number;
  widthPt: number;
  heightPt: number;
  /** Résolution de l'image servie : px = pt × dpi / 72. Absent d'un ancien serveur. */
  dpi?: number;
  image: string;
}

export interface CropUpdate {
  ok: boolean;
  exerciseId: string;
  slot: string;
  image: Crop | null;
  manualSlots: string[];
  exercise: Exercise;
}

export interface CartItem {
  exerciseId: string;
  parts: string[];
}

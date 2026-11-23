/** Identifiants d'emplacement d'image, comme côté serveur. */
export function statementSlot(index: number): string {
  return `statement:${index}`;
}

export function solutionSlot(index: number): string {
  return `solution:${index}`;
}

export function questionSlot(label: string): string {
  return `question:${label}`;
}

export function answerSlot(label: string): string {
  return `answer:${label}`;
}

const SHORT_DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

export function formatShortDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return SHORT_DATE.format(date);
}

export function formatPages(pages: number[]): string {
  if (pages.length === 0) return '—';
  if (pages.length === 1) return `p. ${pages[0]}`;
  const sorted = [...pages].sort((a, b) => a - b);
  return `p. ${sorted[0]}–${sorted[sorted.length - 1]}`;
}

/** « 1.3 à 1.8 et 2.4 » : regroupe les numéros consécutifs d'un même chapitre. */
export function formatNumberList(numbers: string[]): string {
  const groups = new Map<string, number[]>();
  for (const number of numbers) {
    const [chapter, index] = number.split('.');
    if (chapter === undefined || index === undefined) continue;
    const list = groups.get(chapter) ?? [];
    list.push(Number(index));
    groups.set(chapter, list);
  }

  const chunks: string[] = [];
  for (const [chapter, indexes] of groups) {
    const sorted = [...indexes].sort((a, b) => a - b);
    let start = sorted[0]!;
    let previous = start;
    const flush = () => {
      if (start === previous) chunks.push(`${chapter}.${start}`);
      else chunks.push(`${chapter}.${start} à ${chapter}.${previous}`);
    };
    for (const index of sorted.slice(1)) {
      if (index === previous + 1) {
        previous = index;
        continue;
      }
      flush();
      start = index;
      previous = index;
    }
    flush();
  }

  if (chunks.length === 0) return '';
  if (chunks.length === 1) return chunks[0]!;
  return `${chunks.slice(0, -1).join(', ')} et ${chunks[chunks.length - 1]}`;
}

export function exerciseTitle(exercise: { number: string; title: string | null }): string {
  return exercise.title ? `Exercice ${exercise.number} · ${exercise.title}` : `Exercice ${exercise.number}`;
}

export function partLabel(part: string | null): string {
  return part ? `sous-question ${part}` : 'exercice complet';
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return count > 1 ? pluralForm : singular;
}

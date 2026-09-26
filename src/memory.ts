/**
 * Recognising what to keep. Pure text handling, shared by the Node agent and
 * the browser build.
 */

const REMEMBER_PREFIX = /^\s*(?:please\s+)?(?:remember|note|don'?t forget|keep in mind)(?:\s+that)?\s*[:,-]?\s+/i;

/** "remember that my GP is now Dr Rana" -> "my GP is now Dr Rana". null if it is a question. */
export function rememberIntent(text: string): string | null {
  const m = REMEMBER_PREFIX.exec(text);
  if (!m) return null;
  const fact = text.slice(m[0].length).trim();
  // "remember when Sami's birthday is?" is a question, not something to keep.
  return fact.length >= 3 && !fact.endsWith('?') ? fact : null;
}

/** Pull "REMEMBER:" lines out of a rehydrated answer. */
export function splitMemories(answer: string): { answer: string; facts: string[] } {
  const facts: string[] = [];
  const kept = answer
    .split('\n')
    .filter((line) => {
      const m = /^\s*REMEMBER:\s*(.+)$/i.exec(line);
      if (m?.[1]?.trim()) facts.push(m[1].trim());
      return !m;
    })
    .join('\n')
    .trim();
  return { answer: kept, facts };
}

/** The title travels with every disclosed passage, so it stays one word. */
export const MEMORY_TITLE = 'Memory';

/** Only passages that score at least a third of the best one go out. */
export function minimalSet<T extends { score: number }>(hits: T[], k: number): T[] {
  const top = hits[0]?.score ?? 0;
  return hits.filter((h) => h.score >= top / 3).slice(0, k);
}

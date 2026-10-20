/**
 * What happens to a message between the chat box and the send button.
 *
 * The text is redacted with the same code the gateway and the desktop use
 * (src/redact.ts). Placeholders are then renumbered into one space shared by
 * every message this browser sends, so Sami is [PERSON_1] in the first message
 * and still [PERSON_1] in the tenth, and the answer the website shows can be
 * put back on screen from one table. The table stays in this browser; the
 * website only ever receives the placeholders.
 *
 * Words the company always wants hidden (client names, project code names)
 * are found first, whole words and any case, and become [TERM_n].
 */
import { redact, rehydrate } from '../../src/redact.ts';
import type { Policy } from './policy.ts';

/** One placeholder and the real value it stands for. Kept on this computer only. */
export interface Entry {
  ph: string;
  value: string;
  kind: string;
  /** when it was last used, ISO time, so old values can be forgotten */
  at: string;
}

export interface Hidden {
  ph: string;
  value: string;
  kind: string;
}

export interface Protected {
  /** the text to send, with placeholders */
  text: string;
  /** what was hidden, in reading order, one line per placeholder */
  hidden: Hidden[];
  /** count per kind, as the gateway's receipts write it */
  counts: Record<string, number>;
  /** entries the shared table did not have yet, plus the ones used again with a fresh time */
  touched: Entry[];
}

const PLACEHOLDER = /\[([A-Z]+)_(\d+)\]/g;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** two spellings of one value: case and runs of spaces do not count, nor do they in a name */
const sameKey = (kind: string, value: string): string => `${kind}:${value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()}`;

/** Company words, whole words in any case, longest first so "Project Falcon Two" wins over "Project Falcon". */
function hideTerms(text: string, terms: string[]): { text: string; map: Map<string, string> } {
  const map = new Map<string, string>();
  const wanted = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (wanted.length === 0) return { text, map };
  const typed = new Set(text.match(PLACEHOLDER) ?? []);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${wanted.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const byKey = new Map<string, string>();
  let n = 0;
  const out = text.replace(pattern, (m) => {
    const key = sameKey('TERM', m);
    let ph = byKey.get(key);
    if (!ph) {
      do ph = `[TERM_${String(++n)}]`;
      while (typed.has(ph));
      byKey.set(key, ph);
      map.set(ph, m);
    }
    return ph;
  });
  return { text: out, map };
}

/**
 * Hide what NOAI recognises in `text`. `table` is every placeholder this
 * browser has used before. Pure: nothing is stored here, the caller saves
 * `touched`.
 */
/**
 * Added under a message that had something hidden, so the model treats the
 * placeholders as deliberate instead of as missing or suspicious data. Same
 * wording as the gateway's system line (src/gate.ts). Its example has no
 * number, so it is never mistaken for a real placeholder or drawn over.
 */
export const PLACEHOLDER_NOTE =
  '(Note: values in square brackets with a number, like [PERSON_n] or [PHONE_n], are placeholders for private data hidden on my computer by NOAI+. They are deliberate. Use them exactly as written, never guess what they stand for.)';

export function protect(
  text: string,
  table: readonly Entry[],
  policy: Pick<Policy, 'alwaysHide' | 'people'> & { note?: string },
  now = new Date(),
): Protected {
  // 1. company words, then everything redact.ts finds. Names hidden in earlier
  //    messages are hidden again, so a name found once by its cue word ("my
  //    brother Sami") is still hidden when it comes back alone ("Sami agreed").
  const terms = hideTerms(text, policy.alwaysHide);
  const knownNames = table.filter((e) => e.kind === 'PERSON').map((e) => e.value);
  const r = redact(terms.text, { people: [...policy.people, ...knownNames] });
  const local = new Map([...terms.map, ...r.map]);

  // 2. renumber into the shared table
  const byKey = new Map(table.map((e) => [sameKey(e.kind, e.value), e]));
  const top: Record<string, number> = {};
  for (const e of table) {
    const m = /^\[([A-Z]+)_(\d+)\]$/.exec(e.ph);
    if (m) top[m[1]!] = Math.max(top[m[1]!] ?? 0, Number(m[2]));
  }
  // a placeholder the person typed themselves is never given to a value
  const typed = new Set(text.match(PLACEHOLDER) ?? []);
  const at = now.toISOString();
  const rename = new Map<string, string>();
  const hidden: Hidden[] = [];
  const touched: Entry[] = [];
  const counts: Record<string, number> = {};
  for (const m of r.text.matchAll(PLACEHOLDER)) {
    const ph = m[0];
    const value = local.get(ph);
    if (value === undefined || rename.has(ph)) continue;
    const kind = m[1]!;
    let entry = byKey.get(sameKey(kind, value));
    if (!entry) {
      let next: string;
      do next = `[${kind}_${String((top[kind] = (top[kind] ?? 0) + 1))}]`;
      while (typed.has(next));
      entry = { ph: next, value, kind, at };
      byKey.set(sameKey(kind, value), entry);
    }
    rename.set(ph, entry.ph);
    touched.push({ ...entry, at });
    hidden.push({ ph: entry.ph, value, kind });
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  let out = r.text.replace(PLACEHOLDER, (ph) => rename.get(ph) ?? ph);
  if (hidden.length > 0 && policy.note && !out.includes(policy.note)) out = `${out}\n\n${policy.note}`;
  return { text: out, hidden, counts, touched };
}

/** Fold `touched` into the table: new placeholders are added, used ones get a fresh time, old ones past `keepDays` go. */
export function mergeTable(table: readonly Entry[], touched: readonly Entry[], keepDays: number, now = new Date()): Entry[] {
  const byPh = new Map(table.map((e) => [e.ph, e]));
  for (const t of touched) {
    const had = byPh.get(t.ph);
    // Another tab may have given this placeholder to a different value at the same moment. The first one keeps it.
    if (had && sameKey(had.kind, had.value) !== sameKey(t.kind, t.value)) continue;
    byPh.set(t.ph, t);
  }
  const cutoff = now.getTime() - keepDays * 86_400_000;
  return [...byPh.values()].filter((e) => keepDays <= 0 ? true : Date.parse(e.at) >= cutoff);
}

/** The text with every known placeholder put back. */
export const restore = (text: string, table: ReadonlyMap<string, string>): string => rehydrate(text, table as Map<string, string>);

export type Piece = string | { ph: string; value: string };

/**
 * Cut a piece of page text at each known placeholder, for drawing the real
 * value in its place. Returns null when there is nothing to put back.
 */
export function pieces(text: string, table: ReadonlyMap<string, string>): Piece[] | null {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const value = table.get(m[0]);
    if (value === undefined) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ ph: m[0], value });
    last = m.index + m[0].length;
  }
  if (last === 0) return null;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

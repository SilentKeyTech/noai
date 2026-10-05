/**
 * Family check-ins: "Maya took her inhaler" is sealed with the time it was
 * said, and "Did Maya take her meds today?" is answered on the device from
 * those check-ins. Neither calls the model, so neither sends a byte.
 *
 * Pure: no I/O, no clock of its own (the caller passes `now`), so the desktop,
 * the browser and the tests share it.
 */

export const CHECKIN_KIND = 'checkin';

export interface Checkin {
  /** Who checked in, as written ("Maya", or "me"). */
  who: string;
  /** What they did, as written ("took her inhaler"). */
  what: string;
}

export interface CheckinNote {
  title: string;
  body: string;
  addedAt: string;
  kind: string;
}

export interface CheckinQuestion {
  who: string;
  /** The words that say what was asked about ("take her meds"). */
  what: string;
  when: 'today' | 'yesterday' | 'week';
}

export interface CheckinAnswer {
  /** The check-in that answers yes, if any. */
  found: CheckinNote | null;
  /** The latest earlier check-in on the same thing, for a no. */
  last: CheckinNote | null;
  text: string;
}

const DONE = 'took|has taken|had|has had|did|has done|finished|has finished|brushed|ate|drank|fed|walked|went|got home|came home|arrived|practised|practiced|packed|cleaned|tidied';
const STATEMENT = new RegExp(`^(?:check(?:ed)?[ -]?in[:,]?\\s+)?(I|[\\p{Lu}][\\p{L}'-]{1,30})\\s+(?:just\\s+)?((?:${DONE})\\b.*)$`, 'u');
const EXPLICIT = /^check(?:ed)?[ -]?in[:,]?\s+/i;
const ASK = /^(?:did|has|have)\s+([\p{L}'-]{2,30})\s+(?:already\s+)?(take|taken|have|had|do|done|finish|finished|brush|brushed|eat|eaten|drink|drunk|feed|fed|walk|walked|go|gone|get|got|come|arrive|arrived|practise|practice|pack|packed|clean|cleaned|tidy|tidied)\b(.*?)\??$/iu;
// Words that never name a person at the start of a sentence.
const NOT_A_NAME = new Set(['the', 'this', 'that', 'it', 'we', 'they', 'he', 'she', 'you', 'everyone', 'nobody', 'someone', 'who', 'what', 'when', 'where', 'why', 'how']);

/** "Maya took her inhaler" or "check in: I did my homework" becomes a check-in. Questions never do. */
export function checkinIntent(text: string): Checkin | null {
  const t = text.trim().replace(/[.!]+$/, '');
  if (!t || t.endsWith('?')) return null;
  const m = t.match(STATEMENT);
  if (!m) return null;
  const who = m[1] as string;
  if (NOT_A_NAME.has(who.toLowerCase())) return null;
  // Without "check in", only a short plain statement counts, so prose pasted into the box is asked, not filed.
  if (!EXPLICIT.test(t) && t.split(/\s+/).length > 10) return null;
  return { who: who === 'I' ? 'me' : who, what: (m[2] as string).replace(/\s+/g, ' ').trim() };
}

/** "Did Maya take her meds today?" becomes a question the device can answer from check-ins. */
export function checkinQuestion(text: string): CheckinQuestion | null {
  const m = text.trim().match(ASK);
  if (!m) return null;
  const who = m[1] as string;
  if (NOT_A_NAME.has(who.toLowerCase())) return null;
  let rest = (m[3] as string).trim();
  let when: CheckinQuestion['when'] = 'today';
  if (/\byesterday\b/i.test(rest)) when = 'yesterday';
  else if (/\bthis week\b/i.test(rest)) when = 'week';
  rest = rest.replace(/\b(today|this morning|this afternoon|this evening|tonight|yet|yesterday|this week)\b/gi, '').trim();
  return { who: who.toLowerCase() === 'i' ? 'me' : who, what: `${m[2]} ${rest}`.replace(/\s+/g, ' ').trim(), when };
}

// Things people check in about, so "meds" finds "took her inhaler".
const CONCEPTS: string[][] = [
  ['med', 'meds', 'medicine', 'medicines', 'medication', 'pill', 'pills', 'tablet', 'tablets', 'inhaler', 'puffer', 'dose', 'doses', 'vitamin', 'vitamins', 'antibiotic', 'antibiotics', 'insulin', 'drops', 'syrup'],
  ['teeth', 'tooth', 'brush', 'brushed', 'floss', 'flossed'],
  ['homework', 'study', 'studied', 'revision', 'reading', 'read'],
  ['breakfast', 'lunch', 'dinner', 'supper', 'snack', 'eat', 'ate', 'eaten', 'food', 'meal'],
  ['water', 'drink', 'drank', 'drunk'],
  ['home', 'school', 'arrive', 'arrived', 'back'],
  ['dog', 'cat', 'pet', 'fed', 'feed', 'walk', 'walked'],
  ['practice', 'practise', 'practised', 'practiced', 'piano', 'violin', 'training'],
  ['bed', 'sleep', 'nap'],
];
const STOP = new Set(['take', 'taken', 'took', 'have', 'had', 'has', 'do', 'did', 'done', 'her', 'his', 'their', 'my', 'the', 'a', 'an', 'all', 'of', 'to', 'at', 'in', 'on', 'just', 'go', 'gone', 'went', 'get', 'got', 'come', 'came', 'finish', 'finished', 'already', 'some', 'any']);

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function concepts(s: string): Set<number> {
  const out = new Set<number>();
  for (const w of words(s)) CONCEPTS.forEach((group, i) => { if (group.includes(w)) out.add(i); });
  return out;
}
function about(question: string, checkin: string): boolean {
  const qc = concepts(question);
  const cc = concepts(checkin);
  for (const c of qc) if (cc.has(c)) return true;
  if (qc.size > 0) return false;
  const cw = new Set(words(checkin));
  return words(question).some((w) => !STOP.has(w) && cw.has(w));
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function whenSaid(at: Date, now: Date): string {
  if (sameDay(at, now)) return `today at ${clock(at)}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(at, y)) return `yesterday at ${clock(at)}`;
  if (now.getTime() - at.getTime() < 7 * 86400000) return `${DAYS[at.getDay()]} at ${clock(at)}`;
  return `${at.getDate()} ${at.toLocaleString('en-GB', { month: 'short' })} at ${clock(at)}`;
}

function inWindow(at: Date, when: CheckinQuestion['when'], now: Date): boolean {
  if (when === 'today') return sameDay(at, now);
  if (when === 'yesterday') {
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    return sameDay(at, y);
  }
  return now.getTime() - at.getTime() < 7 * 86400000 && at.getTime() <= now.getTime();
}

/**
 * Answer from check-ins alone. Returns null when this person has never checked
 * in about anything, so the question can go to the notes instead.
 */
export function answerCheckin(q: CheckinQuestion, notes: CheckinNote[], now: Date): CheckinAnswer | null {
  const mine = notes
    .filter((n) => n.kind === CHECKIN_KIND && n.title.toLowerCase() === q.who.toLowerCase())
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  if (mine.length === 0) return null;
  const onIt = mine.filter((n) => about(q.what, n.body));
  const found = onIt.find((n) => inWindow(new Date(n.addedAt), q.when, now)) ?? null;
  const who = q.who === 'me' ? 'You' : q.who;
  const period = q.when === 'week' ? 'this week' : q.when;
  if (found) {
    return { found, last: null, text: `Yes. ${who} checked in "${found.body}" ${whenSaid(new Date(found.addedAt), now)}.` };
  }
  const last = onIt[0] ?? null;
  const text = last
    ? `Not ${period}. ${who} has not checked in about that ${period}. The last time was "${last.body}", ${whenSaid(new Date(last.addedAt), now)}.`
    : `No check-in from ${who} about that yet. ${who === 'You' ? 'Your' : `${who}'s`} latest check-in was "${mine[0]!.body}", ${whenSaid(new Date(mine[0]!.addedAt), now)}.`;
  return { found: null, last, text };
}

/** The routines worth a one-tap button: each distinct who and what, most recent first. */
export function routines(notes: CheckinNote[], max = 6): Checkin[] {
  const seen = new Set<string>();
  const out: Checkin[] = [];
  for (const n of notes.filter((x) => x.kind === CHECKIN_KIND).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))) {
    const key = `${n.title.toLowerCase()}|${n.body.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ who: n.title, what: n.body });
    if (out.length === max) break;
  }
  return out;
}

/**
 * Redaction happens on device, before the gate hashes and sends anything.
 * Each value becomes a placeholder like [EMAIL_1]. The map from placeholder to
 * real value never leaves this process, so the answer is rehydrated locally:
 * the model can say "call [PHONE_1]" and the owner reads the real number.
 *
 * Two kinds of value are found here:
 *  - structured identifiers (keys, emails, IBANs, cards, Saudi ID and Iqama
 *    numbers, passport numbers, phones, IPs), matched by pattern on a copy of the text where
 *    Arabic-Indic digits read as 0-9, so ٠٥٥١٢٣٤٥٦٧ is a phone number too;
 *  - names of people, in Latin or Arabic script, found by a name list, by cue
 *    words ("my brother", "Dr.", "أخي", "السيد") and by name chains (bin, Al-,
 *    أبو, عبد). A name found anywhere in a disclosure is hidden everywhere in
 *    it, so the question and the passages agree on [PERSON_1]. The caller can
 *    add the people the vault already knows (src/people.ts), so a name pointed
 *    at in one note is hidden in another where nothing points at it.
 */
import {
  ARABIC_PREFIXES,
  canonName,
  CUE_ARABIC,
  CUE_LATIN_RELATION,
  CUE_LATIN_TITLE,
  FILLER_LATIN,
  GIVEN_ARABIC,
  GIVEN_LATIN,
  JOIN_ARABIC,
  JOIN_LATIN,
  LEAD_ARABIC,
  LEAD_LATIN,
  PLACE_AFTER_LATIN,
  PLACE_BEFORE_ARABIC,
  PLACE_BEFORE_LATIN,
  POSSESSIVE_LATIN,
  STOP_ARABIC,
  STOP_LATIN,
  normToken,
} from './names.ts';

interface Rule {
  kind: string;
  pattern: RegExp;
  accept?: (m: string) => boolean;
}

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * A date written with digits (2026-10-12, 12/10/2026, 12.10.2026) has eight
 * digits like a phone number, but it is not one, and a reminder needs it.
 * Found in a live test on 26 Sep 2026: the model was asked for a date it had
 * been given, because the date had been replaced with [PHONE_1].
 */
function isDate(m: string): boolean {
  const s = m.trim();
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(s) || /^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(s);
}

const noPlaceholder = (m: string): boolean => !/\[[A-Z]+_\d+\]/.test(m);

const NUMERIC_DATE = String.raw`(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{1,2}-\d{1,2})`;
const WRITTEN_DATE = String.raw`(?:\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`;
const DOB = new RegExp(String.raw`(?<=\b(?:born(?:\s+on)?|date\s+of\s+birth|d\.?o\.?b\.?|birth\s*date)\s*[:\-]?\s*|(?:تاريخ الميلاد|مولود|مولودة|ولدت|تاريخ ميلاد[ةه]?)(?:\s+في)?\s*[:\-]?\s*)(?:${NUMERIC_DATE}|${WRITTEN_DATE})`, 'gi');

const ADDRESS_CODE = /\b[A-Z]{4}\d{4}\b/g;
const ADDRESS_STREET = /\b\d{1,5}\s+(?:[A-Z][\w'-]*\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way)\b\.?(?:,?\s+(?:[A-Z][\w'-]*\s*){1,3})?/g;
const ADDRESS_CUED = /(?<=\b(?<!e-?mail |ip |web |mac )(?:(?:my|our|his|her|their|home|work|office|delivery|shipping|billing|mailing|street|postal|postal code|zip code|po box)\s+address\s*(?:is|:)?|lives?\s+at|living\s+at|resides?\s+at|located\s+at|p\.?o\.?\s*box|postal\s+code|zip\s+code)\s*[:\-]?\s*)[^\n.;!?]{4,80}/gi;
const ADDRESS_CUED_ARABIC = /(?<=(?:العنوان|عنواني|ص\.?\s?ب\.?|الرمز البريدي|رقم المبنى|يسكن في|تسكن في|اسكن في|أسكن في)\s*[:\-]?\s*)[^\n.؛!؟]{3,60}/g;

const MEDICAL_TERMS = [
  'diabetes', 'diabetic', 'hypertension', 'high blood pressure', 'cancer', 'chemotherapy', 'leukemia', 'leukaemia', 'HIV', 'hepatitis',
  'asthma', 'epilepsy', 'depression', 'anxiety disorder', 'bipolar', 'schizophrenia', 'ADHD', 'autism', 'PTSD', 'pregnant', 'pregnancy', 'miscarriage',
  'dialysis', 'kidney failure', 'heart disease', 'heart attack', 'migraine', 'arthritis', 'tuberculosis', 'insulin', 'metformin',
  'antidepressants?', 'antipsychotics?',
].join('|');
const MEDICAL_ARABIC = ['سكري', 'سرطان', 'ربو', 'صرع', 'اكتئاب', 'فصام', 'إيدز', 'ايدز', 'الفشل الكلوي', 'التهاب الكبد', 'حامل', 'غسيل الكلى', 'جلطة', 'ارتفاع الضغط', 'ضغط الدم'].join('|');
const MEDICAL = new RegExp(String.raw`(?<![\p{L}])(?:${MEDICAL_TERMS})(?![\p{L}])|(?<![\p{L}])(?:[والفب]?(?:ال)?)(?:${MEDICAL_ARABIC})(?![\p{L}])`, 'giu');

/**
 * Order matters: the most specific patterns run first.
 *
 * ID is a Saudi national ID (starts with 1) or Iqama (starts with 2): ten
 * digits. It runs before PHONE, which would otherwise take it. No checksum is
 * required on purpose: a check digit we got wrong would let a real ID through,
 * and hiding a ten digit number that was not an ID costs almost nothing.
 */
const RULES: Rule[] = [
  { kind: 'SECRET', pattern: /\b(?:sk|pk|rk|ghp|gho|xox[bap]|AKIA)[-_A-Za-z0-9]{16,}\b/g },
  { kind: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'IBAN', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  { kind: 'CARD', pattern: /\b(?:\d[ -]?){13,19}\b/g, accept: luhn },
  { kind: 'ID', pattern: /(?<![\d+])[12]\d{9}(?!\d)/g },
  // A date of birth: only a full date with a year, and only after a cue. A birthday
  // with no year ("turns 30 on 22 November") stays readable, a reminder needs it.
  { kind: 'DOB', pattern: DOB, accept: noPlaceholder },
  // Where someone lives: a Saudi National Address code (four letters, four digits),
  // a numbered street, or whatever follows "my address is", "lives at", العنوان.
  { kind: 'ADDRESS', pattern: ADDRESS_CODE },
  { kind: 'ADDRESS', pattern: ADDRESS_STREET, accept: noPlaceholder },
  { kind: 'ADDRESS', pattern: ADDRESS_CUED, accept: noPlaceholder },
  { kind: 'ADDRESS', pattern: ADDRESS_CUED_ARABIC, accept: noPlaceholder },
  { kind: 'MEDICAL', pattern: MEDICAL },
  { kind: 'PASSPORT', pattern: /\b[A-Z]{1,2}\d{6,8}\b/g },
  { kind: 'PHONE', pattern: /(?<![\w])\+?\d[\d\s().-]{6,}\d(?![\w])/g, accept: (m) => m.replace(/\D/g, '').length >= 8 && !isDate(m) },
  { kind: 'IP', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

const PLACEHOLDER = /^\[[A-Z]+_\d+\]$/;

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits as 0-9. One UTF-16 unit each way, so offsets line up. */
function asciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => String((c.charCodeAt(0) & 0xf) % 10));
}

export interface Redaction {
  text: string;
  counts: Record<string, number>;
  /** placeholder -> original, stays on device */
  map: Map<string, string>;
}

export interface RedactOptions {
  /** Names the owner has listed as people to always hide, in any script. */
  people?: string[];
  /**
   * Other names for a person, as [other, name] pairs: a nickname or a spelling
   * the owner taught ("Hamoudi is short for Mohammed Haddad"). Both are hidden,
   * under one placeholder. Spellings of common names (Mohd, Mhmd, محمد) are
   * already one name, see SPELLINGS in names.ts.
   */
  same?: [string, string][];
}

class Placeholders {
  readonly byValue = new Map<string, string>();
  readonly map = new Map<string, string>();
  readonly counts: Record<string, number> = {};

  get(kind: string, key: string, original: string): string {
    const k = `${kind}:${key}`;
    let ph = this.byValue.get(k);
    if (!ph) {
      this.counts[kind] = (this.counts[kind] ?? 0) + 1;
      ph = `[${kind}_${String(this.counts[kind])}]`;
      this.byValue.set(k, ph);
      this.map.set(ph, original);
    }
    return ph;
  }
}

function redactStructured(input: string, ph: Placeholders): string {
  let orig = input;
  for (const rule of RULES) {
    const norm = asciiDigits(orig);
    let out = '';
    let last = 0;
    for (const m of norm.matchAll(rule.pattern)) {
      const at = m.index;
      const seen = m[0];
      if (PLACEHOLDER.test(seen)) continue;
      if (rule.accept && !rule.accept(seen)) continue;
      out += orig.slice(last, at) + ph.get(rule.kind, seen, orig.slice(at, at + seen.length));
      last = at + seen.length;
    }
    orig = out + orig.slice(last);
  }
  return orig;
}

// ---------------------------------------------------------------- names

interface Token {
  /** start of the core, after any attached Arabic prefix */
  cs: number;
  /** end of the core, before any possessive 's */
  e: number;
  n: string;
  cap: boolean;
  ar: boolean;
}

const WORD = /[\p{L}\p{M}\u0640]+(?:['’-][\p{L}\p{M}\u0640]+)*/gu;
const ARABIC = /[\u0600-\u06FF]/;

function tokenize(text: string, known: Set<string>): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    let cs = m.index;
    let raw = m[0];
    const ar = ARABIC.test(raw);
    if (!ar && /['’]s$/i.test(raw) && raw.length > 3) raw = raw.slice(0, -2);
    let n = normToken(raw);
    if (ar && n.length >= 4 && ARABIC_PREFIXES.includes(n[0] ?? '')) {
      const rest = canonName(n.slice(1));
      if (GIVEN_ARABIC.has(rest) || known.has(rest)) {
        n = rest;
        cs += 1;
        while (/[\u064B-\u065F\u0670\u0640]/.test(text[cs] ?? '')) cs += 1;
      }
    }
    out.push({ cs, e: m.index + raw.length, n, cap: !ar && /^\p{Lu}/u.test(raw), ar });
  }
  return out;
}

const isGiven = (t: Token): boolean => (t.ar ? GIVEN_ARABIC.has(t.n) : GIVEN_LATIN.has(t.n) || GIVEN_LATIN.has(t.n.replace(/['-]/g, '')));
const isStop = (t: Token): boolean => (t.ar ? STOP_ARABIC.has(t.n) : STOP_LATIN.has(t.n));

/** A word that can stand as a name after a cue: a capitalised Latin word, or an Arabic word that is not a function word. */
const nameable = (t: Token): boolean => !isStop(t) && (t.ar ? t.n.length >= 2 : t.cap);

/** A word that continues a name already started: Haddad, Al-Otaibi, الزهراني, a second given name. */
function continues(t: Token): boolean {
  if (isStop(t)) return false;
  if (isGiven(t)) return true;
  if (t.ar) return t.n.startsWith('ال') && t.n.length >= 4;
  return t.cap;
}

function adjacent(text: string, a: Token, b: Token, allowDot = false): boolean {
  const gap = text.slice(a.e, b.cs);
  return allowDot ? /^[.,:]?[ \t\u00A0]+$/.test(gap) : /^[ \t\u00A0]+$/.test(gap);
}

interface Span {
  from: number;
  to: number;
  key: string;
}

/** King Fahd Road, مستشفى الملك فيصل: a name used as part of a place. */
function isPlace(text: string, tok: Token[], start: number, end: number): boolean {
  const before = tok[start - 1];
  const after = tok[end + 1];
  const first = tok[start]!;
  const last = tok[end]!;
  if (before && before.ar === first.ar && adjacent(text, before, first) && (first.ar ? PLACE_BEFORE_ARABIC : PLACE_BEFORE_LATIN).has(before.n)) return true;
  return !!after && !after.ar && !last.ar && adjacent(text, last, after) && PLACE_AFTER_LATIN.has(after.n);
}

/** Find where a name starts after a cue at token i, or -1. */
function afterCue(text: string, tok: Token[], i: number): number {
  const t = tok[i]!;
  if (t.ar) {
    const next = tok[i + 1];
    return CUE_ARABIC.has(t.n) && next?.ar && adjacent(text, t, next, true) && nameable(next) ? i + 1 : -1;
  }
  let k = -1;
  if (CUE_LATIN_TITLE.has(t.n)) k = i + 1;
  else if (POSSESSIVE_LATIN.has(t.n) && tok[i + 1] && CUE_LATIN_RELATION.has(tok[i + 1]!.n) && adjacent(text, t, tok[i + 1]!)) k = i + 2;
  if (k < 0 || !tok[k]) return -1;
  if (FILLER_LATIN.has(tok[k]!.n) && tok[k + 1] && adjacent(text, tok[k]!, tok[k + 1]!)) k += 1;
  const prev = tok[k - 1]!;
  const cand = tok[k]!;
  return !cand.ar && adjacent(text, prev, cand, true) && nameable(cand) ? k : -1;
}

/** Pass one: find every name in one text, as a normalised key and its surface form. */
function findNames(text: string): { key: string; surface: string }[] {
  const tok = tokenize(text, new Set());
  const found: { key: string; surface: string }[] = [];
  let i = 0;
  while (i < tok.length) {
    const t = tok[i]!;
    let start = -1;
    let j = -1;
    const next = tok[i + 1];
    const leads = t.ar ? LEAD_ARABIC.has(t.n) : LEAD_LATIN.has(t.n);
    if (leads && next && next.ar === t.ar && adjacent(text, t, next) && nameable(next)) {
      start = i;
      j = i + 1;
    } else if (isGiven(t)) {
      start = i;
      j = i;
    } else {
      const k = afterCue(text, tok, i);
      if (k >= 0) {
        start = k;
        j = k;
      }
    }
    if (start < 0) {
      i += 1;
      continue;
    }
    while (j - start < 5) {
      const a = tok[j]!;
      const b = tok[j + 1];
      if (!b || b.ar !== a.ar || !adjacent(text, a, b)) break;
      const joins = b.ar ? JOIN_ARABIC.has(b.n) : JOIN_LATIN.has(b.n);
      const c = tok[j + 2];
      if (joins && c && c.ar === b.ar && adjacent(text, b, c) && (continues(c) || nameable(c))) j += 2;
      else if (continues(b)) j += 1;
      else break;
    }
    const parts = tok.slice(start, j + 1);
    if (isPlace(text, tok, start, j)) {
      i = j + 1;
      continue;
    }
    found.push({ key: parts.map((p) => p.n).join(' '), surface: text.slice(parts[0]!.cs, parts[parts.length - 1]!.e) });
    i = j + 1;
  }
  return found;
}

/** Every name the finder sees in one text, as written. Used to learn names from the whole vault. */
export function findPeople(text: string): string[] {
  return findNames(text).map((f) => f.surface);
}

/** Pass two: every occurrence of a known name, full or by one of its parts, in one text. */
function locateNames(text: string, keys: string[][], alias: Map<string, string>): Span[] {
  const known = new Set(alias.keys());
  for (const k of keys) for (const p of k) known.add(p);
  const tok = tokenize(text, known);
  const spans: Span[] = [];
  let i = 0;
  outer: while (i < tok.length) {
    // King Fahd Road stays a road even when Fahd is a known person.
    for (const key of keys) {
      if (key.length < 2 || tok[i]!.n !== key[0]) continue;
      let ok = true;
      for (let x = 1; x < key.length; x++) {
        const a = tok[i + x - 1];
        const b = tok[i + x];
        if (!a || !b || b.n !== key[x] || !adjacent(text, a, b)) {
          ok = false;
          break;
        }
      }
      if (ok && !isPlace(text, tok, i, i + key.length - 1)) {
        spans.push({ from: tok[i]!.cs, to: tok[i + key.length - 1]!.e, key: key.join(' ') });
        i += key.length;
        continue outer;
      }
    }
    // A known name that is also a function word (a contact called Will or May)
    // is hidden as part of the full name, never as the word on its own.
    const single = isStop(tok[i]!) ? undefined : alias.get(tok[i]!.n);
    if (single && !isPlace(text, tok, i, i)) spans.push({ from: tok[i]!.cs, to: tok[i]!.e, key: single });
    i += 1;
  }
  return spans;
}

const keyOf = (name: string): string => name.trim().split(/\s+/).filter(Boolean).map(normToken).join(' ');

function redactNames(texts: string[], ph: Placeholders, people: string[], same: [string, string][]): string[] {
  const surface = new Map<string, string>();
  for (const p of people) {
    const key = keyOf(p);
    if (key && !surface.has(key)) surface.set(key, p.trim());
  }
  // A taught other name is found like any name, and numbered as the person it stands for.
  const stands = new Map<string, string>();
  for (const [other, name] of same) {
    const o = keyOf(other);
    const n = keyOf(name);
    if (!o || !n || o === n) continue;
    if (!surface.has(n)) surface.set(n, name.trim());
    if (!surface.has(o)) surface.set(o, other.trim());
    stands.set(o, n);
  }
  for (const t of texts) for (const f of findNames(t)) if (!surface.has(f.key)) surface.set(f.key, f.surface);
  if (surface.size === 0) return texts;

  // A part of a longer name, alone (Sami for Sami Haddad), stands for that name
  // when only one known name contains it. A part shared by two names, such as
  // a family surname, gets a placeholder of its own.
  const keys = [...surface.keys()].map((k) => k.split(' ')).sort((a, b) => b.length - a.length);
  const owner = new Map<string, string | null>();
  for (const k of keys) {
    if (k.length < 2) continue;
    for (const part of k) {
      if (part.length < 3 || JOIN_LATIN.has(part) || JOIN_ARABIC.has(part) || LEAD_LATIN.has(part) || LEAD_ARABIC.has(part)) continue;
      const full = k.join(' ');
      owner.set(part, owner.has(part) && owner.get(part) !== full ? null : full);
    }
  }
  const alias = new Map<string, string>();
  for (const k of keys) if (k.length === 1) alias.set(k[0]!, owner.get(k[0]!) ?? k[0]!);
  for (const [part, full] of owner) if (!alias.has(part)) alias.set(part, full ?? part);

  return texts.map((text) => {
    // Numbered in reading order, spliced from the end so offsets stay valid.
    const spans = locateNames(text, keys, alias).map((s) => {
      const key = stands.get(s.key) ?? s.key;
      return { ...s, ph: ph.get('PERSON', key, surface.get(key) ?? text.slice(s.from, s.to)) };
    });
    let out = text;
    for (const s of spans.reverse()) out = out.slice(0, s.from) + s.ph + out.slice(s.to);
    return out;
  });
}

/**
 * Redact one or more texts with a shared placeholder space, so the same value
 * gets the same placeholder in the question and in every passage.
 */
export function redactAll(texts: string[], opts: RedactOptions = {}): { texts: string[]; counts: Record<string, number>; map: Map<string, string> } {
  const ph = new Placeholders();
  const structured = texts.map((t) => redactStructured(t, ph));
  const out = redactNames(structured, ph, opts.people ?? [], opts.same ?? []);
  return { texts: out, counts: ph.counts, map: ph.map };
}

export function redact(text: string, opts: RedactOptions = {}): Redaction {
  const r = redactAll([text], opts);
  return { text: r.texts[0] ?? '', counts: r.counts, map: r.map };
}

export function rehydrate(text: string, map: Map<string, string>): string {
  return text.replace(/\[[A-Z]+_\d+\]/g, (ph) => map.get(ph) ?? ph);
}

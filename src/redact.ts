/**
 * Redaction happens on device, before the gate hashes and sends anything.
 * Each value becomes a placeholder like [EMAIL_1]. The map from placeholder to
 * real value never leaves this process, so the answer is rehydrated locally:
 * the model can say "call [PHONE_1]" and the owner reads the real number.
 *
 * Two kinds of value are found here:
 *  - structured identifiers (API keys and tokens, private keys, emails, IBANs,
 *    cards, Saudi ID and Iqama numbers, passport numbers, phones, IPs), matched
 *    by pattern on a copy of the text where Arabic-Indic and full width digits
 *    read as 0-9 and every dash as a hyphen, so ٠٥٥١٢٣٤٥٦٧ and 055–123–4567
 *    are phone numbers too;
 *  - names of people, in Latin or Arabic script, found by a name list, by cue
 *    words ("my brother", "Dr.", "أخي", "السيد") and by name chains (bin, Al-,
 *    أبو, عبد). A name found anywhere in a disclosure is hidden everywhere in
 *    it, so the question and the passages agree on [PERSON_1]. The caller can
 *    add the people the vault already knows (src/people.ts), so a name pointed
 *    at in one note is hidden in another where nothing points at it.
 *
 * Matching runs on the text with invisible characters (zero width space, bidi
 * marks and the like) taken out, so "Sa\u200Bmi" is still Sami, and again with
 * each of them read as a space, so "Sami\u200BHaddad" is still two words. What
 * either reading finds is hidden. The output keeps every character the owner
 * typed outside a hidden value; a placeholder maps back to a structured value
 * as it was written, and to a name without the invisible characters.
 *
 * A placeholder the owner typed, say a literal [PHONE_1] in a note, is never
 * mapped to anything, and no generated placeholder takes its name.
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
  INVISIBLE,
  JOIN_ARABIC,
  JOIN_LATIN,
  LEAD_ARABIC,
  LEAD_LATIN,
  PLACE_AFTER_LATIN,
  PLACE_AL,
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
  /** when accept says no: a shorter start of the match that is a value, or null. An IBAN typed in lower case can take the word after it. */
  shrink?: (m: string) => string | null;
  /** what makes two matches the same value, when not the text itself: a phone is its digits */
  key?: (m: string) => string;
  /** a match to leave readable and keep later rules out of: a certificate, which is public but looks like a key */
  keep?: boolean;
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
 * The IBAN check (ISO 7064 mod 97-10). An IBAN in capitals is hidden on sight,
 * as before: a mistyped one should not leak. One typed in lower case has to
 * check out, so that a build id or a hash does not read as a bank account.
 */
function ibanChecks(s: string): boolean {
  const t = s.replace(/\s/g, '').toUpperCase();
  let mod = 0;
  for (const c of t.slice(4) + t.slice(0, 4)) {
    for (const d of /\d/.test(c) ? c : String(c.charCodeAt(0) - 55)) mod = (mod * 10 + Number(d)) % 97;
  }
  return mod === 1;
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
const IBAN = /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){3,7}(?: ?[A-Za-z0-9]{1,4})?\b/g;
/** An IBAN in capitals is hidden on sight. One with a lower case letter in it must check out, and may have taken the word after it. */
const ibanOk = (m: string): boolean => !/[a-z]/.test(m) || ibanChecks(m);
function ibanShrink(m: string): string | null {
  const parts = m.split(' ');
  while (parts.length > 1) {
    parts.pop();
    const s = parts.join(' ');
    if (new RegExp(`^${IBAN.source.slice(2, -2)}$`).test(s) && ibanOk(s)) return s;
  }
  return null;
}

const RULES: Rule[] = [
  // A private key in PEM or PGP armour, BEGIN to END, however many lines. With the END line missing, the lines of base64 and headers that follow BEGIN.
  // It runs before the certificate rule below: a certificate body cannot hold a BEGIN line, so a key inside or after one is a key.
  { kind: 'SECRET', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|[ \t]*(?:\r?\n(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+: ?[^\r\n]*|=[A-Za-z0-9+/]{4}|(?=\r?\n))[ \t]*)*)/g },
  // A certificate or a public key in armour is public. It stays, and the key body rule below does not read into it. It ends on its own END line and never crosses a BEGIN line.
  { kind: 'KEEP', pattern: /-----BEGIN ((?:[A-Z]+ )*(?:CERTIFICATE|PUBLIC KEY)(?: BLOCK)?)-----(?:(?!-----BEGIN )[\s\S])*?-----END \1-----/g, keep: true },
  // A key body with no armour: DER in base64 starts MII, an OpenSSH key starts with "openssh-key-v1" in base64. Lines of base64 that follow belong to it.
  { kind: 'SECRET', pattern: /\b(?:MII[A-Za-z0-9+/=]{60,}|b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]{20,})(?:\r?\n[A-Za-z0-9+/=]{16,})*/g },
  // API keys and tokens by their prefix: GitHub classic and fine grained, Google, Slack, AWS, Stripe-style, and a JWT or JWE (a base64url JSON header, then two to four more parts, or one more and an empty signature).
  { kind: 'SECRET', pattern: /\b(?:github_pat_[A-Za-z0-9_]{30,}|AIza[\w-]{35}(?![\w-])|eyJ[\w-]{8,}\.[\w-]{8,}(?:(?:\.[\w-]+){1,3}|\.)(?![\w-])|(?:sk|pk|rk|ghp|gho|xox[bap]|AKIA)[-_A-Za-z0-9]{16,}\b)/g },
  { kind: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'IBAN', pattern: IBAN, accept: ibanOk, shrink: ibanShrink },
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
  { kind: 'PHONE', pattern: /(?<![\w])\+?\d[\d\s().-]{6,}\d(?![\w])/g, accept: (m) => m.replace(/\D/g, '').length >= 8 && !isDate(m), key: (m) => m.replace(/[^\d+]/g, '') },
  { kind: 'IP', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

const PLACEHOLDER = /^\[[A-Z]+_\d+\]$/;
const ANY_PLACEHOLDER = /\[[A-Z]+_\d+\]/g;

/**
 * A copy of the text where every digit reads as 0-9 and every dash as a
 * hyphen: Arabic-Indic (٠-٩), Extended Arabic-Indic (۰-۹) and full width
 * (０-９) digits, the full width plus, and the en dash, em dash, figure dash
 * and minus sign a phone is sometimes typed with. One UTF-16 unit each way,
 * so offsets line up with the text the owner wrote.
 */
function fold(s: string): string {
  return s
    .replace(/[\u0660-\u0669\u06F0-\u06F9\uFF10-\uFF19]/g, (c) => String((c.charCodeAt(0) & 0xf) % 10))
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-')
    .replace(/\uFF0B/g, '+');
}

const HAS_INVISIBLE = new RegExp(INVISIBLE.source);

/** One text as the finders read it, and as the owner wrote it. */
interface Prepared {
  /** what every pattern runs on: the original without its invisible characters, or with each of them as a space */
  text: string;
  original: string;
  /** at[i] is where character i of text sits in original; null when text and original line up one to one */
  at: number[] | null;
}

/** The text with invisible characters taken out, so Sa\u200Bmi is Sami. */
function stripped(original: string): Prepared {
  if (!HAS_INVISIBLE.test(original)) return { text: original, original, at: null };
  const at: number[] = [];
  let text = '';
  for (let i = 0; i < original.length; i++) {
    const c = original[i]!;
    if (HAS_INVISIBLE.test(c)) continue;
    at.push(i);
    text += c;
  }
  return { text, original, at };
}

/** The text with each invisible character as a space, so Sami\u200BHaddad is two words. Same length, so offsets are the original's. */
const spaced = (original: string): Prepared => ({ text: original.replace(INVISIBLE, ' '), original, at: null });

/** Where characters from `from` to `to` of a prepared text sit in the original. The last character's own place ends the span, so an invisible character right after a value is not part of it. */
function placed(p: Prepared, from: number, to: number): [number, number] {
  if (!p.at) return [from, to];
  const start = p.at[from] ?? p.original.length;
  return [start, to > from ? (p.at[to - 1] ?? p.original.length - 1) + 1 : start];
}

/** A value to hide: where it sits, what kind it is, what makes it the same as another, and what the placeholder stands for. */
interface Found {
  from: number;
  to: number;
  kind: string;
  key: string;
  /** null until placed in the original, when it becomes the text as written */
  value: string | null;
  /** the structured rule that found it, for a second look at a value an invisible character runs through */
  rule?: Rule;
}

/**
 * A pass that has found its values blanks them, same length, before the next
 * pass runs, so nothing matches into a value already taken and every offset
 * still points into the same text. NUL is in no pattern and is not a letter.
 */
const BLANK = '\u0000';
function blank(text: string, found: { from: number; to: number }[]): string {
  let out = text;
  for (const f of found) out = out.slice(0, f.from) + BLANK.repeat(f.to - f.from) + out.slice(f.to);
  return out;
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
  private readonly last: Record<string, number> = {};
  /** placeholders already written in the input, which no generated one may be confused with */
  private readonly taken: Set<string>;

  constructor(texts: string[]) {
    this.taken = new Set(texts.flatMap((t) => t.match(ANY_PLACEHOLDER) ?? []));
  }

  get(kind: string, key: string, original: string): string {
    const k = `${kind}:${key}`;
    let ph = this.byValue.get(k);
    if (!ph) {
      this.counts[kind] = (this.counts[kind] ?? 0) + 1;
      let n = this.last[kind] ?? 0;
      do {
        n += 1;
        ph = `[${kind}_${String(n)}]`;
      } while (this.taken.has(ph));
      this.last[kind] = n;
      this.byValue.set(k, ph);
      this.map.set(ph, original);
    }
    return ph;
  }
}

/** Every structured value in one prepared text, and the text with those values blanked for the passes that follow. */
function redactStructured(text: string): { found: Found[]; blanked: string } {
  const found: Found[] = [];
  let blanked = text;
  for (const rule of RULES) {
    const norm = fold(blanked);
    const mine: Found[] = [];
    for (const m of norm.matchAll(rule.pattern)) {
      let seen = m[0];
      if (seen.includes(BLANK) || PLACEHOLDER.test(seen)) continue;
      if (rule.accept && !rule.accept(seen)) {
        const shorter = rule.shrink?.(seen);
        if (!shorter) continue;
        seen = shorter;
      }
      mine.push({ from: m.index, to: m.index + seen.length, kind: rule.kind, key: rule.key ? rule.key(seen) : seen, value: null, rule });
    }
    if (mine.length === 0) continue;
    if (!rule.keep) found.push(...mine);
    blanked = blank(blanked, mine);
  }
  return { found, blanked };
}

// ---------------------------------------------------------------- companies

/**
 * A company is found by its legal form: Sandpiper Fitout Co., Harbourline
 * Contracting LLC, شركة الرمال للمقاولات. Once found, the name without the form
 * ("Sandpiper Fitout") and its first word when that word is distinctive
 * ("Sandpiper") are hidden everywhere under the same placeholder, because a
 * contract names a party in full once and then by a short name.
 *
 * "The Company", "the Group" and "the Contractor" stay readable: they are the
 * defined terms a contract question is about, and they name no one.
 */
const LEGAL_FORM = String.raw`(?:Co\.|Company|Corp\.?|Corporation|Inc\.?|Incorporated|L\.?L\.?C\.?|Ltd\.?|Limited|PLC|LLP|GmbH|FZE|FZ-LLC|FZCO|Est\.|Establishment|Holdings?|Group)`;
const COMPANY_LATIN = new RegExp(String.raw`\b[A-Z][\w'’-]*(?:\s+(?:[A-Z][\w'’-]*|&|and)){0,5}?\s+${LEGAL_FORM}(?:\s+${LEGAL_FORM})?(?![\w])`, 'g');
const COMPANY_ARABIC_LEAD = /(?<![\p{L}])(?:شركة|مؤسسة|مجموعة)\s+/gu;

/** Words that open a name without being part of it, and words too common to stand for one company. */
const COMPANY_LEAD = new Set(['the', 'this', 'that', 'such', 'said', 'any', 'each', 'a', 'an', 'our', 'your', 'their', 'his', 'her', 'my', 'its', 'every', 'other']);
const COMPANY_GENERIC = new Set([
  'saudi', 'arabia', 'arabian', 'national', 'international', 'gulf', 'global', 'united', 'general', 'middle', 'east', 'west', 'north', 'south',
  'al', 'first', 'new', 'royal', 'advanced', 'modern', 'trading', 'contracting', 'services', 'service', 'group', 'holding', 'holdings',
  'company', 'contractor', 'subcontractor', 'client', 'employer', 'supplier', 'buyer', 'seller', 'party', 'parties', 'owner', 'consultant',
  'riyadh', 'jeddah', 'dammam', 'kingdom', 'arab', 'emirates', 'dubai', 'technology', 'technologies', 'solutions', 'industrial', 'industries',
]);

const COMPANY_GENERIC_ARABIC = new Set(['السعودية', 'العربية', 'الوطنية', 'الدولية', 'المتحدة', 'الخليج', 'الخليجية', 'العامة', 'المتقدمة', 'الحديثة', 'الأولى', 'الاولى', 'للتجارة', 'للمقاولات', 'للخدمات']);

interface Company {
  surface: string;
  /** shorter ways the same company is written later */
  short: string[];
}

function findCompanies(text: string): Company[] {
  const out: Company[] = [];
  for (const m of text.matchAll(COMPANY_LATIN)) {
    let words = m[0].split(/\s+/);
    while (words.length > 1 && COMPANY_LEAD.has(words[0]!.toLowerCase())) words = words.slice(1);
    const core = words.slice(0, -1).filter((w) => w !== '&' && w !== 'and');
    // "The Company", "the Group": a defined term, not a name.
    if (!core.some((w) => !COMPANY_GENERIC.has(w.toLowerCase()) && !STOP_LATIN.has(normToken(w)))) continue;
    const surface = words.join(' ');
    const short: string[] = [];
    const name = words.slice(0, -1).join(' ');
    if (name.includes(' ')) short.push(name);
    const first = core[0]!;
    if (first.length >= 4 && !COMPANY_GENERIC.has(first.toLowerCase()) && !STOP_LATIN.has(normToken(first)) && !GIVEN_LATIN.has(normToken(first))) short.push(first);
    out.push({ surface, short });
  }
  for (const m of text.matchAll(COMPANY_ARABIC_LEAD)) {
    // The first word after شركة is the name; later words join only when they read
    // as part of it: الرمال, للمقاولات, السعودية. A verb or a function word ends it.
    const rest = text.slice(m.index + m[0].length);
    const words: string[] = [];
    for (const w of rest.matchAll(/[؀-ۿـ]+|[^؀-ۿـ]+/g)) {
      const t = w[0];
      if (!/^[؀-ۿـ]+$/.test(t)) {
        if (/^[ \t ]+$/.test(t) && words.length < 4) continue;
        break;
      }
      const n = normToken(t);
      if (STOP_ARABIC.has(n)) break;
      if (words.length > 0 && !n.startsWith('ال') && !n.startsWith('لل')) break;
      words.push(t);
      if (words.length === 4) break;
    }
    if (words.length === 0) continue;
    const name = words.join(' ');
    const short = [name];
    const first = normToken(words[0]!);
    if (words.length > 1 && first.length >= 5 && !COMPANY_GENERIC_ARABIC.has(first)) short.push(words[0]!);
    out.push({ surface: `${m[0]}${name}`, short });
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redactCompanies(texts: string[]): Found[][] {
  // The full name found anywhere numbers the company; its short forms point at it.
  const owner = new Map<string, string | null>();
  const full: string[] = [];
  for (const t of texts) {
    for (const c of findCompanies(t)) {
      if (!owner.has(c.surface)) full.push(c.surface);
      owner.set(c.surface, c.surface);
      for (const s of c.short) owner.set(s, owner.has(s) && owner.get(s) !== c.surface ? null : c.surface);
    }
  }
  if (full.length === 0) return texts.map(() => []);
  // Longest first, so "Sandpiper Fitout Co." is taken before "Sandpiper". A short
  // form shared by two companies stays readable rather than point at the wrong one.
  const forms = [...owner.entries()].filter((e): e is [string, string] => e[1] !== null).sort((a, b) => b[0].length - a[0].length);
  const re = new RegExp(forms.map(([f]) => `(?<![\\p{L}\\p{N}])${escapeRe(f)}(?![\\p{L}\\p{N}])`).join('|'), 'gu');
  return texts.map((text) =>
    [...text.matchAll(re)].map((m) => {
      const company = owner.get(m[0])!;
      // Keyed without spaces or case, so the two readings of Sandpiper\u200BFitout Co. are one company.
      return { from: m.index, to: m.index + m[0].length, kind: 'COMPANY', key: company.replace(/\s+/g, '').toLowerCase(), value: company };
    }),
  );
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
/** The Arabic article written in Latin script: Al Rashid, El Masri open a family name, and Al-Rashid is one on its own. Al Khobar and Al-Jazeera are not people. */
const ARTICLE_LATIN = new Set(['al', 'el']);
const articled = (t: Token): boolean => {
  const m = /^(?:al|el)-(\p{L}{3,})$/u.exec(t.n);
  return !t.ar && t.cap && !!m && !PLACE_AL.has(m[1]!);
};
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

/** Pass one: find every name in one prepared text, as a normalised key, its surface form and where it sits. */
function findNames(text: string): { key: string; surface: string; from: number; to: number }[] {
  const tok = tokenize(text, new Set());
  const found: { key: string; surface: string; from: number; to: number }[] = [];
  let i = 0;
  while (i < tok.length) {
    const t = tok[i]!;
    let start = -1;
    let j = -1;
    const next = tok[i + 1];
    const leads = t.ar ? LEAD_ARABIC.has(t.n) : LEAD_LATIN.has(t.n) || (t.cap && ARTICLE_LATIN.has(t.n) && !!next && !PLACE_AL.has(next.n));
    if (leads && next && next.ar === t.ar && adjacent(text, t, next) && nameable(next)) {
      start = i;
      j = i + 1;
    } else if (isGiven(t) || articled(t)) {
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
    const from = parts[0]!.cs;
    const to = parts[parts.length - 1]!.e;
    found.push({ key: parts.map((p) => p.n).join(' '), surface: text.slice(from, to), from, to });
    i = j + 1;
  }
  return found;
}

/** Every name the finder sees in one text, without invisible characters, under either reading of them. Used to learn names from the whole vault. */
export function findPeople(text: string): string[] {
  const first = stripped(text);
  const asFound = (p: Prepared): Found[] =>
    findNames(p.text).map((f) => {
      const [from, to] = placed(p, f.from, f.to);
      return { from, to, kind: 'PERSON', key: f.key, value: f.surface };
    });
  const names = first.at ? union(text, asFound(first), asFound(spaced(text))) : asFound(first);
  return [...new Set(names.map((f) => f.value!))];
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

function redactNames(texts: string[], people: string[], same: [string, string][]): Found[][] {
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
  if (surface.size === 0) return texts.map(() => []);

  // A shorter name that sits inside exactly one longer one (Al Saud in Mohammed
  // bin Salman Al Saud) is that name written short, and is numbered as it.
  const keys = [...surface.keys()].map((k) => k.split(' ')).sort((a, b) => b.length - a.length);
  const within = new Map<string, string | null>();
  for (const k of keys) {
    if (k.length < 2) continue;
    for (const other of keys) {
      if (other.length <= k.length || !other.some((_, at) => k.every((w, x) => other[at + x] === w))) continue;
      const full = other.join(' ');
      const short = k.join(' ');
      within.set(short, within.has(short) && within.get(short) !== full ? null : full);
    }
  }
  for (const [short, full] of within) if (full && !stands.has(short)) stands.set(short, full);

  // A part of a longer name, alone (Sami for Sami Haddad), stands for that name
  // when only one known name contains it. A part shared by two names, such as
  // a family surname, gets a placeholder of its own.
  const owner = new Map<string, string | null>();
  for (const k of keys) {
    if (k.length < 2 || stands.has(k.join(' '))) continue;
    for (const part of k) {
      if (part.length < 3 || JOIN_LATIN.has(part) || JOIN_ARABIC.has(part) || LEAD_LATIN.has(part) || LEAD_ARABIC.has(part)) continue;
      const full = k.join(' ');
      owner.set(part, owner.has(part) && owner.get(part) !== full ? null : full);
    }
  }
  const alias = new Map<string, string>();
  for (const k of keys) if (k.length === 1) alias.set(k[0]!, owner.get(k[0]!) ?? k[0]!);
  for (const [part, full] of owner) if (!alias.has(part)) alias.set(part, full ?? part);

  // The placeholder stands for the name as first seen, without invisible characters.
  return texts.map((text) =>
    locateNames(text, keys, alias).map((s) => {
      const key = stands.get(s.key) ?? s.key;
      return { from: s.from, to: s.to, kind: 'PERSON', key, value: surface.get(key) ?? text.slice(s.from, s.to) };
    }),
  );
}

/**
 * A structured value an invisible character runs through is two values when
 * each visible piece is a whole match of the same rule on its own: two phone
 * numbers with only a zero width space between them, which both readings
 * take as one number because a space may sit inside a phone number.
 */
function splitAtInvisible(original: string, f: Found): Found[] {
  const rule = f.rule;
  const slice = original.slice(f.from, f.to);
  if (!rule || !HAS_INVISIBLE.test(slice)) return [f];
  const pieces: Found[] = [];
  let at = f.from;
  for (const piece of slice.split(INVISIBLE)) {
    const from = at;
    at += piece.length + 1;
    if (!piece) continue;
    const m = [...fold(piece).matchAll(rule.pattern)];
    if (m.length !== 1 || m[0]![0] !== fold(piece) || (rule.accept && !rule.accept(m[0]![0]))) return [f];
    pieces.push({ ...f, from, to: from + piece.length, key: rule.key ? rule.key(fold(piece)) : fold(piece), value: piece });
  }
  return pieces.length > 1 ? pieces : [f];
}

/** Everything to hide in each prepared text, placed in the original, in reading order. */
function findAll(prepped: Prepared[], opts: RedactOptions): Found[][] {
  const structured = prepped.map((p) => redactStructured(p.text));
  const companies = redactCompanies(structured.map((s) => s.blanked));
  const names = redactNames(structured.map((s, i) => blank(s.blanked, companies[i]!)), opts.people ?? [], opts.same ?? []);
  return prepped.map((p, i) =>
    [...structured[i]!.found, ...companies[i]!, ...names[i]!]
      .map((f) => {
        const [from, to] = placed(p, f.from, f.to);
        return { ...f, from, to, value: f.value ?? p.original.slice(from, to) };
      })
      .sort((a, b) => a.from - b.from),
  );
}

/**
 * What two readings of one text found, as one list. Where they overlap, the
 * reading that covers more visible characters wins: a@b.com\u200Bc@d.com is
 * two addresses in the second reading and one odd one in the first. On a tie,
 * more values win (two phones over one that spans both), then a name with
 * more words (Al Rashid over AlRashid), then the first reading, with the
 * invisible characters gone, is the one meant.
 */
function union(original: string, first: Found[], second: Found[]): Found[] {
  const all = [...first.map((f) => ({ f, second: false })), ...second.map((f) => ({ f, second: true }))].sort((a, b) => a.f.from - b.f.from || b.f.to - a.f.to);
  const visible = (f: Found): number => original.slice(f.from, f.to).replace(INVISIBLE, '').length;
  const words = (f: Found): number => (f.kind === 'PERSON' || f.kind === 'COMPANY' ? (f.value ?? '').split(/\s+/).length : 0);
  const out: Found[] = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    let end = all[i]!.f.to;
    while (j + 1 < all.length && all[j + 1]!.f.from < end) {
      j += 1;
      end = Math.max(end, all[j]!.f.to);
    }
    const group = all.slice(i, j + 1);
    const score = (second: boolean): number[] => {
      const mine = group.filter((g) => g.second === second).map((g) => g.f);
      return [mine.reduce((n, f) => n + visible(f), 0), mine.length, mine.reduce((n, f) => n + words(f), 0)];
    };
    const [a, b] = [score(false), score(true)];
    let pick = false;
    for (let k = 0; k < a.length; k++) {
      if (a[k] === b[k]) continue;
      pick = b[k]! > a[k]!;
      break;
    }
    out.push(...group.filter((g) => g.second === pick).map((g) => g.f));
    i = j + 1;
  }
  return out;
}

/**
 * Redact one or more texts with a shared placeholder space, so the same value
 * gets the same placeholder in the question and in every passage.
 */
export function redactAll(texts: string[], opts: RedactOptions = {}): { texts: string[]; counts: Record<string, number>; map: Map<string, string> } {
  const ph = new Placeholders(texts);
  const first = texts.map(stripped);
  let found = findAll(first, opts);
  // When any text has invisible characters, every text is read again with each of them as a space, and what
  // either reading finds is hidden: a name learned from Sami\u200BHaddad in one text hides Haddad in the others.
  if (first.some((p) => p.at)) {
    const second = findAll(texts.map(spaced), opts);
    found = found.map((f, i) => union(texts[i]!, f, second[i]!).flatMap((x) => splitAtInvisible(texts[i]!, x)));
  }
  // Placeholders are numbered in reading order and put into the text as the owner wrote it.
  const out = texts.map((text, i) => {
    let result = '';
    let last = 0;
    for (const f of found[i]!) {
      result += text.slice(last, f.from) + ph.get(f.kind, f.key, f.value ?? text.slice(f.from, f.to));
      last = f.to;
    }
    return result + text.slice(last);
  });
  return { texts: out, counts: ph.counts, map: ph.map };
}

export function redact(text: string, opts: RedactOptions = {}): Redaction {
  const r = redactAll([text], opts);
  return { text: r.texts[0] ?? '', counts: r.counts, map: r.map };
}

export function rehydrate(text: string, map: Map<string, string>): string {
  return text.replace(/\[[A-Z]+_\d+\]/g, (ph) => map.get(ph) ?? ph);
}

/**
 * Rehydrate a reply that arrives in pieces. A placeholder can be cut across two
 * pieces ("[EMAI" then "L_1]"), so anything after the last "[" that could still
 * become a placeholder is held back until the next piece or the end.
 */
export class StreamRehydrator {
  private held = '';
  private readonly map: Map<string, string>;
  constructor(map: Map<string, string>) {
    this.map = map;
  }

  push(piece: string): string {
    const text = this.held + piece;
    const open = text.lastIndexOf('[');
    const cut = open >= 0 && text.length - open <= 24 && /^\[[A-Z]*(?:_\d*)?$/.test(text.slice(open)) ? open : text.length;
    this.held = text.slice(cut);
    return rehydrate(text.slice(0, cut), this.map);
  }

  /** The end of the reply: whatever was held is plain text after all. */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rehydrate(rest, this.map);
  }
}

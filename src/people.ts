/**
 * Who the owner knows, worked out on the device from the vault itself.
 *
 * The redactor only sees one disclosure at a time. A name that is pointed at
 * in one note ("my brother Wissam") but written bare in another ("Wissam paid
 * the deposit") would leave the device in the second if the redactor only
 * looked at the passages it is about to send. So before every disclosure the
 * whole vault is read here, on the device, and every person it names is handed
 * to the redactor as a name to always hide:
 *
 *  - names the finder recognises in any note (list, cue words, name chains);
 *  - the people who wrote in an imported WhatsApp chat;
 *  - imported contacts (.vcf), which is how the owner hands over a list of
 *    people whose names nothing in the text would point at.
 *
 * Pure: no model, no network, no storage. The list lives only for the call.
 */
import {
  CUE_ARABIC,
  CUE_LATIN_RELATION,
  CUE_LATIN_TITLE,
  GIVEN_LATIN,
  POSSESSIVE_LATIN,
  STOP_ARABIC,
  STOP_LATIN,
  normToken,
} from './names.ts';
import { findPeople } from './redact.ts';

export interface NoteLike {
  title: string;
  body: string;
}

/** A message line as parseWhatsApp writes it: "14:03 Sami Haddad: text". */
const WA_LINE = /^\d{2}:\d{2} ([^:\n]{1,60}): /gm;
/** A contact as parseVcard writes it: title "Contact: ...", a "Name: ..." line. */
const CONTACT_TITLE = /^Contact: /;
const CONTACT_NAME = /^Name: (.+)$/m;
const WORD = /[\p{L}\p{M}ـ]+(?:['’-][\p{L}\p{M}ـ]+)*/gu;
const ARABIC = /[؀-ۿ]/;

const isLead = (n: string, ar: boolean): boolean =>
  ar ? CUE_ARABIC.has(n) : CUE_LATIN_TITLE.has(n) || CUE_LATIN_RELATION.has(n) || POSSESSIVE_LATIN.has(n);

/**
 * A name as a contact book or chat holds it, reduced to the words that are the
 * person: "Dr. Karam Nassar 🦷" -> "Karam Nassar", "Uncle Ziad" -> "Ziad". A
 * label with no name in it ("Mom", "pizza place", a phone number) gives null.
 */
export function cleanName(raw: string): string | null {
  const words = [...raw.normalize('NFKC').matchAll(WORD)].map((m) => m[0]);
  while (words.length > 0) {
    const w = words[0]!;
    if (!isLead(normToken(w), ARABIC.test(w))) break;
    words.shift();
  }
  if (words.length === 0 || words.length > 5) return null;
  if (words.length === 1) {
    const w = words[0]!;
    const n = normToken(w);
    const ar = ARABIC.test(w);
    if (ar ? STOP_ARABIC.has(n) || n.length < 2 : STOP_LATIN.has(n) || n.length < 2) return null;
  }
  // A Latin name is written with a capital, or is a given name. "pizza place" is not a person.
  const latin = words.filter((w) => !ARABIC.test(w));
  if (latin.length > 0 && !latin.some((w) => /^\p{Lu}/u.test(w) || GIVEN_LATIN.has(normToken(w)))) return null;
  return words.join(' ');
}

/**
 * The owner teaching another name for someone, in a note or a memory:
 *   "Hamoudi is short for Mohammed Haddad", "Mo is a nickname for Mohammed",
 *   "Mhmd is also written Mohammed", "حمودي اختصار لمحمد", "أبو علي اسم دلع ل..."
 */
const TAUGHT = [
  /(?:^|[.!?;:]\s+)([^.!?,;:\n]{1,60}?) is (?:short for|a nickname for|another name for|another spelling of|also written|also spelled|also spelt) ([^.!?,;:\n]{1,60})/gim,
  /(?:^|[.!?;:،؛]\s+)([^.!?,;:،؛\n]{1,60}?) (?:اختصار|اسم دلع|لقب) (?:لاسم|لـ|ل)\s*([^.!?,;:،؛\n]{1,60})/gm,
];
const CONTACT_NICK = /^Nickname: (.+)$/gm;

/** A word that can be part of a name: Arabic and not a function word, or Latin with a capital or a given name. */
function namePart(w: string): boolean {
  const n = normToken(w);
  if (ARABIC.test(w)) return !STOP_ARABIC.has(n) && !CUE_ARABIC.has(n);
  return !STOP_LATIN.has(n) && (/^\p{Lu}/u.test(w) || GIVEN_LATIN.has(n));
}

/** The name at one end of a phrase: "my cousin Hamoudi" -> "Hamoudi", "Mohammed Haddad who lives" -> "Mohammed Haddad". */
function nameAtEnd(phrase: string, end: 'start' | 'end'): string | null {
  const all = [...phrase.normalize('NFKC').matchAll(WORD)].map((m) => m[0]);
  const words = end === 'end' ? [...all].reverse() : all;
  const kept: string[] = [];
  for (const w of words) {
    if (!namePart(w) || kept.length === 5) break;
    kept.push(w);
  }
  if (end === 'end') kept.reverse();
  // An owner who types in lower case still means a name: "hamoudi is short for mohammed".
  if (kept.length === 0 && words.length > 0 && words.length <= 2) {
    return all.some((w) => STOP_LATIN.has(normToken(w)) || STOP_ARABIC.has(normToken(w))) ? null : all.join(' ');
  }
  return cleanName(kept.join(' '));
}

export interface KnownPeople {
  /** every person the vault names, once each, in the order first seen */
  people: string[];
  /** [other name, name] pairs the owner taught or a contact holds */
  same: [string, string][];
}

/** Everything the vault says about who people are, ready for redactAll's options. */
export function knownPeople(notes: NoteLike[]): KnownPeople {
  const out = new Map<string, string>();
  const same: [string, string][] = [];
  const add = (name: string | null): void => {
    if (!name) return;
    const key = name.split(/\s+/).map(normToken).join(' ');
    if (!out.has(key)) out.set(key, name);
  };
  const link = (other: string | null, name: string | null): void => {
    if (!other || !name) return;
    add(name);
    add(other);
    same.push([other, name]);
  };
  for (const n of notes) {
    if (CONTACT_TITLE.test(n.title)) {
      const name = cleanName(CONTACT_NAME.exec(n.body)?.[1] ?? '');
      add(name);
      for (const m of n.body.matchAll(CONTACT_NICK)) for (const nick of (m[1] ?? '').split(',')) link(cleanName(nick), name);
    }
    for (const m of n.body.matchAll(WA_LINE)) add(cleanName(m[1] ?? ''));
    for (const re of TAUGHT) for (const m of n.body.matchAll(re)) link(nameAtEnd(m[1] ?? '', 'end'), nameAtEnd(m[2] ?? '', 'start'));
    for (const text of [n.title, n.body]) for (const f of findPeople(text)) add(f);
  }
  return { people: [...out.values()], same };
}

/** Every person the vault names, once each, in the order first seen. */
export function peopleFromNotes(notes: NoteLike[]): string[] {
  return knownPeople(notes).people;
}

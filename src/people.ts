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

/** Every person the vault names, once each, in the order first seen. */
export function peopleFromNotes(notes: NoteLike[]): string[] {
  const out = new Map<string, string>();
  const add = (name: string | null): void => {
    if (!name) return;
    const key = name.split(/\s+/).map(normToken).join(' ');
    if (!out.has(key)) out.set(key, name);
  };
  for (const n of notes) {
    if (CONTACT_TITLE.test(n.title)) add(cleanName(CONTACT_NAME.exec(n.body)?.[1] ?? ''));
    for (const m of n.body.matchAll(WA_LINE)) add(cleanName(m[1] ?? ''));
    for (const text of [n.title, n.body]) for (const f of findPeople(text)) add(f);
  }
  return [...out.values()];
}

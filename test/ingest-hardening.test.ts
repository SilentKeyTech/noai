/**
 * Import under bad input. WhatsApp exports that are empty, binary, badly
 * dated, missing a sender, spread over many lines or absurdly long must not
 * crash the importer and must not turn garbage into a person or a note title.
 * The Arabic PDF must come out as real letters and be redacted before it leaves.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ask } from '../src/agent.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { importFile, readForImport } from '../src/importer.ts';
import { type Ingested, ingestText, looksLikeWhatsApp, parseWhatsApp } from '../src/ingest.ts';
import { readReceipts } from '../src/ledger.ts';
import { knownPeople } from '../src/people.ts';
import { redact, rehydrate } from '../src/redact.ts';
import { addNote, createVault, readNotes } from '../src/vault.ts';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const PASS = 'a passphrase used only by this test';
const CHAT = 'Sami Haddad';
const FILE = `WhatsApp Chat with ${CHAT}.txt`;
const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'noai-ingest-hard-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const fixture = (f: string): string => new URL(`./fixtures/${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cfg = (root: string): GateConfig => ({ root, baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'test', model: 'nvidia/nemotron-3-super-120b-a12b', maxPayloadBytes: 8000, maxTokens: 4096 });
function capture(): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  const transport: Transport = async (_u, init) => {
    sent.push(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok [P1]' }, finish_reason: 'stop' }], usage: null }) };
  };
  return { transport, sent };
}

/** Bytes that are not text, the same on every run. */
function garbage(n: number): Buffer {
  const b = Buffer.alloc(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    b[i] = (x >>> 16) & 0xff;
  }
  return b;
}

const TITLE = new RegExp(`^WhatsApp with ${CHAT}, \\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}$`);
/** A person is letters, with the odd apostrophe, dot or hyphen. Nothing else may reach the hidden-names list. */
const PERSON = /^[\p{L}\p{M}]+(?:[ '’.-][\p{L}\p{M}]+)*\.?$/u;

/** Nothing in a parse may carry garbage as a name: every title is the chat name plus a day, every person is letters. */
function assertNoGarbageNames(r: Ingested): void {
  for (const n of r.notes) assert.match(n.title, TITLE, `a title made from the export: ${JSON.stringify(n.title.slice(0, 80))}`);
  for (const p of knownPeople(r.notes).people) assert.match(p, PERSON, `not a person: ${JSON.stringify(p.slice(0, 80))}`);
}

describe('a malformed WhatsApp export', () => {
  it('an empty file, or one of blank lines, gives no notes and a plain warning; an import adds nothing', async () => {
    for (const text of ['', '\n\n   \n', '\uFEFF\r\n']) {
      const r = parseWhatsApp(text, CHAT);
      assert.deepEqual(r.notes, []);
      assert.match(r.warnings[0]!, /No messages were found/);
      assert.ok(!looksLikeWhatsApp(text));
      const t = ingestText(text, FILE);
      assert.deepEqual([t.format, t.notes, t.warnings], ['text', [], ['The file is empty.']]);
    }
    const root = await tmp();
    const v = await createVault(root, PASS);
    const file = join(root, FILE);
    await writeFile(file, '');
    const r = await importFile(v, file);
    assert.deepEqual([r.added, r.alreadyThere], [0, 0]);
    assert.equal(readNotes(v).length, 0);
  });

  it('binary garbage is not a chat, makes no person, and does not crash', async () => {
    const bytes = garbage(4096);
    const text = bytes.toString('utf8');
    assert.ok(!looksLikeWhatsApp(text));
    const r = parseWhatsApp(text, CHAT);
    assert.deepEqual(r.notes, []);
    assertNoGarbageNames(r);
    // As a plain file it is one note named after the file, never after its contents.
    const t = ingestText(text, FILE);
    assert.equal(t.format, 'text');
    assert.deepEqual(
      t.notes.map((n) => n.title),
      [`WhatsApp Chat with ${CHAT}`],
    );
    for (const p of knownPeople(t.notes).people) assert.match(p, PERSON);
    const root = await tmp();
    const v = await createVault(root, PASS);
    const file = join(root, FILE);
    await writeFile(file, bytes);
    await importFile(v, file);
    for (const n of readNotes(v)) assert.equal(n.title, `WhatsApp Chat with ${CHAT}`);
  });

  it('a line with no sender is not a message and does not swallow the one after it', () => {
    const text = [
      '12/10/2026, 09:14 - Messages and calls are end-to-end encrypted.',
      '12/10/2026, 09:15 - just text after the dash, nobody said it',
      '12/10/2026, 09:16 - : an empty sender',
      '12/10/2026, 09:17 -',
      '12/10/2026, 09:18 - Sami Haddad: this one is real',
      'and it continues here',
    ].join('\n');
    const r = parseWhatsApp(text, CHAT);
    assert.deepEqual(
      r.notes.map((n) => n.body),
      ['09:18 Sami Haddad: this one is real\nand it continues here'],
    );
    assertNoGarbageNames(r);
    assert.deepEqual(knownPeople(r.notes).people, ['Sami Haddad']);
    const none = parseWhatsApp(text.split('\n').slice(0, 4).join('\n'), CHAT);
    assert.deepEqual(none.notes, []);
    assert.match(none.warnings[0]!, /No messages were found/);
  });

  it('dates in the wrong shape are not crashes: the lines that parse are kept, the rest are dropped', () => {
    const text = [
      '2026-10-12 09:15 - Sami Haddad: an ISO date',
      'Oct 12, 2026 9:15 AM - Sami Haddad: a written month',
      '12/10/2026 Sami Haddad: no time at all',
      '12.10.26 09:15 Sami Haddad: dots and no dash, which one locale writes',
      '12/10/2026, 09:15 - Sami Haddad: this one parses',
      '13/10/2026, 8:05 PM - Sami Haddad: and so does this',
      '٠٠/٠٠/٠٠٠٠، ٠:٠٠ ص - Sami Haddad: a date that does not exist',
    ].join('\n');
    const r = parseWhatsApp(text, CHAT);
    assertNoGarbageNames(r);
    assert.deepEqual(knownPeople(r.notes).people, ['Sami Haddad']);
    const bodies = r.notes.map((n) => n.body).join('\n');
    assert.ok(bodies.includes('09:15 Sami Haddad: this one parses'));
    assert.ok(bodies.includes('20:05 Sami Haddad: and so does this'));
    assert.ok(bodies.includes('09:15 Sami Haddad: dots and no dash'));
    for (const dropped of ['ISO date', 'written month', 'no time at all']) assert.ok(!bodies.includes(dropped), `${dropped} was taken as a message`);
  });

  it('a message over many lines, with blank lines and lines that start with a number, stays one message', () => {
    const text = [
      '12/10/2026, 09:15 - Sami Haddad: shopping list',
      '2 kg rice',
      '',
      '   ',
      '12 eggs',
      '12/10 is the date, not a header',
      '12/10/2026, 09:20 - Ramzi: got it',
    ].join('\r\n');
    const r = parseWhatsApp(text, CHAT);
    assert.equal(r.notes.length, 1);
    assert.equal(r.notes[0]!.body, '09:15 Sami Haddad: shopping list\n2 kg rice\n12 eggs\n12/10 is the date, not a header\n09:20 Ramzi: got it');
    assertNoGarbageNames(r);
  });

  it('a 3 MB line, a 50,000 character sender and a file with no line breaks at all are handled in seconds', { timeout: 30_000 }, () => {
    const long = 'x'.repeat(3_000_000);
    const started = Date.now();
    const r = parseWhatsApp(`12/10/2026, 09:15 - Sami Haddad: ${long}\n12/10/2026, 09:16 - Ramzi: short`, CHAT);
    assert.equal(r.notes.length, 1);
    assert.equal(r.notes[0]!.body.length, '09:15 Sami Haddad: '.length + long.length + '\n09:16 Ramzi: short'.length);
    assertNoGarbageNames(r);

    const sender = 'A'.repeat(50_000);
    const s = parseWhatsApp(`12/10/2026, 09:15 - ${sender}: hi`, CHAT);
    assert.equal(s.notes.length, 1);
    assertNoGarbageNames(s);
    // The chat partner from the file name is a person. The 50,000 character sender is not.
    assert.deepEqual(knownPeople(s.notes).people, [CHAT]);

    const flat = ingestText(long, FILE);
    assert.equal(flat.format, 'text');
    assert.equal(flat.notes.length, 1);
    assert.ok(Date.now() - started < 10_000, 'the parser took too long on a long line');
  });

  it('a sender made of control characters, markup, digits or punctuation never becomes a person', () => {
    const senders = ['\u0000\u0001\u0002', '<script>alert(1)</script>', '12345', '....', '\uFFFD\uFFFD', '-- --', '{{secret:github_token}}', '\u202E\u202Dreversed'];
    const text = senders.map((who, i) => `12/10/2026, 09:${String(10 + i)} - ${who}: hello`).join('\n');
    const r = parseWhatsApp(text, CHAT);
    assert.equal(r.notes.length, 1);
    assertNoGarbageNames(r);
    assert.deepEqual(knownPeople(r.notes).people, [CHAT]);
  });

  it('a BOM, Windows line ends, direction marks and a NUL inside a message do not stop the lines from parsing', () => {
    const text = '\uFEFF\u200E12/10/2026, 09:15 - Sami Haddad: one\u0000two\r\n12/10/2026, 09:16 - \u200ERamzi: three\r\n';
    const r = parseWhatsApp(text, CHAT);
    assert.equal(r.notes.length, 1);
    assert.equal(r.notes[0]!.body, '09:15 Sami Haddad: one\u0000two\n09:16 Ramzi: three');
    assertNoGarbageNames(r);
    assert.deepEqual(knownPeople(r.notes).people, ['Sami Haddad', 'Ramzi']);
  });
});

describe('the Arabic PDF', () => {
  const ARABIC = /[؀-ۿ]/;
  const PRESENTATION_FORMS = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const MOJIBAKE = /[\u0080-\u00FF\uFFFD]/;

  it('comes out as searchable Arabic letters in reading order, not empty, not glyph forms, not mojibake', async () => {
    const r = await readForImport(fixture('letter-ar.pdf'));
    assert.equal(r.format, 'pdf');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.notes.length, 1);
    const { title, body } = r.notes[0]!;
    assert.equal(title, 'letter-ar');
    const lines = body.split('\n');
    assert.ok(lines.length >= 4, body);
    assert.equal(lines[0], 'عقد إيجار');
    assert.ok(ARABIC.test(body));
    assert.ok(!PRESENTATION_FORMS.test(body), 'glyph forms were not folded back to letters');
    assert.ok(!MOJIBAKE.test(body), 'the text was decoded with the wrong charset');
    assert.ok(!/[A-Za-z]/.test(body), 'Latin letters in a letter that has none');
    // Letters joined into words, with the name and the number intact.
    assert.ok(body.includes('سامي الزهراني'));
    assert.ok(body.includes('٠٥٥١٢٣٤٥٦٧'));
    assert.ok(body.includes('٣٠٠٠ ريال'));
  });

  it('names the tenant as a person to hide, and the redactor hides the name and the phone and keeps the rent', async () => {
    const r = await readForImport(fixture('letter-ar.pdf'));
    const known = knownPeople(r.notes);
    assert.ok(known.people.includes('سامي الزهراني'), JSON.stringify(known.people));
    const body = r.notes[0]!.body;
    const red = redact(body, known);
    for (const s of ['سامي', 'الزهراني', '٠٥٥١٢٣٤٥٦٧']) assert.ok(!red.text.includes(s), `${s} survived redaction`);
    assert.ok(red.text.includes('٣٠٠٠ ريال'));
    assert.deepEqual(red.counts, { PHONE: 1, PERSON: 1 });
    assert.equal(rehydrate(red.text, red.map), body);
  });

  it('a Saudi IBAN written inside Arabic text is hidden too', () => {
    const red = redact('حساب الإيجار SA03 8000 0000 6080 1016 7519 باسم سامي الزهراني، جوال ٠٥٥١٢٣٤٥٦٧ أو +966 55 123 4567');
    for (const s of ['SA03', '6080', '7519', 'سامي', 'الزهراني', '٠٥٥١٢٣٤٥٦٧', '123 4567']) assert.ok(!red.text.includes(s), `${s} survived redaction`);
    assert.deepEqual(red.counts, { IBAN: 1, PHONE: 2, PERSON: 1 });
  });

  it('imported, sealed, and asked about: the name, the phone and an IBAN never leave, the rent does, and the receipt counts them', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    const r = await importFile(v, fixture('letter-ar.pdf'));
    assert.deepEqual([r.format, r.added], ['pdf', 1]);
    await addNote(v, 'حساب الإيجار', 'يحول الإيجار إلى حساب سامي الزهراني SA03 8000 0000 6080 1016 7519 في أول كل شهر.');
    const raw = await readFile(join(root, 'vault.json'), 'utf8');
    for (const s of ['سامي', 'الزهراني', 'إيجار', 'SA03', '٠٥٥١٢٣٤٥٦٧']) assert.ok(!raw.includes(s), `${s} is readable in the vault file`);

    const { transport, sent } = capture();
    const a = await ask(v, cfg(root), 'كم الإيجار الشهري ومتى يدفع؟', 3, transport, null);
    const b = await ask(v, cfg(root), 'إلى أي حساب يحول الإيجار؟', 3, transport, null);
    const left = sent.join('\n');
    assert.equal(sent.length, 2);
    assert.ok(left.includes('٣٠٠٠ ريال'));
    for (const s of ['سامي', 'الزهراني', '٠٥٥١٢٣٤٥٦٧', 'SA03', '8000 0000', '6080 1016 7519']) assert.ok(!left.includes(s), `${s} left the device`);
    assert.ok(a.signed.receipt.redactions.PERSON! >= 1 && a.signed.receipt.redactions.PHONE! >= 1, JSON.stringify(a.signed.receipt.redactions));
    assert.ok(b.signed.receipt.redactions.IBAN! >= 1, JSON.stringify(b.signed.receipt.redactions));
    assert.equal((await readReceipts(root)).length, 2);
  });
});

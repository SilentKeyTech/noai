/**
 * The people the vault knows, hidden in every disclosure. Each test is one
 * claim about names, including the limit that remains. No network: the model
 * is a function that records what it was sent.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ask } from '../src/agent.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { importFile } from '../src/importer.ts';
import { ingestText, parseVcard } from '../src/ingest.ts';
import { cleanName, peopleFromNotes } from '../src/people.ts';
import { redactAll, rehydrate } from '../src/redact.ts';
import { addNote, createVault } from '../src/vault.ts';
// @ts-expect-error plain JavaScript module, generated and tested as is
import { respond as webRespond } from '../web/app/lib/agent.js';
// @ts-expect-error plain JavaScript module
import { memoryStore } from '../web/app/lib/store.js';
// @ts-expect-error plain JavaScript module
import { addNote as webAddNote, createVault as webCreateVault } from '../web/app/lib/vault.js';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'noai-people-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PASS = 'a passphrase used only by this test';
const cfg = (root: string): GateConfig => ({ root, baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'test', model: 'nvidia/nemotron-3-super-120b-a12b', maxPayloadBytes: 8000, maxTokens: 4096 });
function capture(reply = 'ok [P1]'): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  const transport: Transport = async (_u, init) => {
    sent.push(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: null }) };
  };
  return { transport, sent };
}

/** vCard 2.1 quoted-printable as Android writes it, with a soft line break in the middle. */
function qp(s: string): string {
  const hex = [...Buffer.from(s, 'utf8')].map((b) => `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  return `${hex.slice(0, 30)}=\n${hex.slice(30)}`;
}

describe('contacts import', () => {
  it('reads a vCard 3.0 export: name, numbers, email, folded lines', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Grace Okonkwo',
      'N:Okonkwo;Grace;;;',
      'TEL;TYPE=CELL:+966 55 123 4567',
      'EMAIL;TYPE=INTERNET:grace@example.com',
      'ORG:Acme Trading;Finance',
      'NOTE:Met at the Riyadh office\\, introduced by Sami.',
      ' Prefers WhatsApp.',
      'END:VCARD',
    ].join('\r\n');
    const r = ingestText(vcf, 'contacts.vcf');
    assert.equal(r.format, 'contacts');
    assert.equal(r.notes.length, 1);
    assert.equal(r.notes[0]!.title, 'Contact: Grace Okonkwo');
    assert.equal(
      r.notes[0]!.body,
      'Name: Grace Okonkwo\nPhone: +966 55 123 4567\nEmail: grace@example.com\nOrganisation: Acme Trading, Finance\nNote: Met at the Riyadh office, introduced by Sami.Prefers WhatsApp.',
    );
  });

  it('reads Android vCard 2.1 with an Arabic name in quoted-printable, and a card with only N', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qp('زكرياوي الحربي')}`,
      'TEL;CELL:0551234567',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N:Tamarind;Zorbek;;Dr.;',
      'END:VCARD',
    ].join('\n');
    const r = parseVcard(vcf);
    assert.deepEqual(r.notes.map((n) => n.title), ['Contact: زكرياوي الحربي', 'Contact: Dr. Zorbek Tamarind']);
    assert.equal(r.warnings.length, 0);
  });

  it('says so when a file has no contacts in it', () => {
    const r = ingestText('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD\n', 'empty.vcf');
    assert.equal(r.notes.length, 0);
    assert.match(r.warnings[0] ?? '', /No contacts/);
  });
});

describe('who the vault names', () => {
  it('keeps the person from a contact label, and drops labels that are not names', () => {
    assert.equal(cleanName('Dr. Karam Nassar 🦷'), 'Karam Nassar');
    assert.equal(cleanName('Uncle Ziad'), 'Ziad');
    assert.equal(cleanName('أخي زكرياوي'), 'زكرياوي');
    assert.equal(cleanName('Mom'), null);
    assert.equal(cleanName('pizza place'), null);
    assert.equal(cleanName('+966 55 123 4567'), null);
  });

  it('collects contacts, WhatsApp senders and names the text points at, once each', () => {
    const people = peopleFromNotes([
      { title: 'Contact: Grace Okonkwo', body: 'Name: Grace Okonkwo\nPhone: +966 55 123 4567' },
      { title: 'WhatsApp with Family, 12/10/2026', body: '14:03 Kofi Mensah: landed\n14:05 Kofi Mensah: see you soon\n14:06 +966 55 765 4321: who is this' },
      { title: 'House', body: 'My landlord, Quist, wants the rent. Ask my brother Sami.' },
    ]);
    assert.deepEqual(people, ['Grace Okonkwo', 'Kofi Mensah', 'Quist', 'Sami']);
  });
});

describe('a name pointed at once is hidden everywhere', () => {
  it('hides a bare name in the passage sent, because another note in the vault points at it', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Money', 'My accountant is Zorbek Tamarind.');
    await addNote(v, 'Flat', 'Zorbek paid the deposit of 2000 USD on 3 March.');
    const { transport, sent } = capture('Paid by [PERSON_1]. [P1]');
    const r = await ask(v, cfg(root), 'Who paid the deposit for the flat?', 1, transport);
    assert.ok(!sent[0]!.includes('Zorbek'), 'a name the vault knows left the device');
    assert.ok(sent[0]!.includes('[PERSON_1] paid the deposit'));
    assert.match(r.answer, /Zorbek/, 'the owner reads the real name back');
    assert.equal(r.signed.receipt.redactions.PERSON, 1);
  });

  it('hides a name nothing in the text points at, once the owner imports contacts', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'House', 'Zorvath fixed the roof on 22 November.');
    await addNote(v, 'Work', 'Grace from HR approved the leave.');
    const file = join(root, 'contacts.vcf');
    await writeFile(file, 'BEGIN:VCARD\nVERSION:3.0\nFN:Zorvath Quell\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nFN:Grace Okonkwo\nEND:VCARD\n');
    const imported = await importFile(v, file);
    assert.equal(imported.added, 2);
    const a = capture();
    await ask(v, cfg(root), 'When did Zorvath fix the roof?', 1, a.transport);
    assert.ok(!a.sent[0]!.includes('Zorvath'), 'a contact name left the device');
    const b = capture();
    await ask(v, cfg(root), 'Who approved the leave?', 1, b.transport);
    assert.ok(!b.sent[0]!.includes('Grace'), 'a contact name that is also a word left the device');
  });

  it('hides an Arabic contact name, with a prefix attached', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Contact: زكرياوي الحربي', 'Name: زكرياوي الحربي');
    await addNote(v, 'البيت', 'اتصل بزكرياوي لإصلاح السقف.');
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'من سيصلح السقف؟', 1, transport);
    const body = JSON.parse(sent[0]!) as { messages: { content: string }[] };
    const user = body.messages[1]!.content;
    assert.ok(!user.includes('زكرياوي'), 'an Arabic contact name left the device');
    assert.ok(user.includes('اتصل ب[PERSON_1]'));
  });

  it('works the same in the browser build', async () => {
    const store = memoryStore();
    const v = await webCreateVault(store, PASS);
    await webAddNote(v, 'Money', 'My accountant is Zorbek Tamarind.');
    await webAddNote(v, 'Flat', 'Zorbek paid the deposit of 2000 USD on 3 March.');
    const sent: string[] = [];
    const transport = async (_url: string, init: { body: string }) => {
      sent.push(init.body);
      const out = JSON.stringify({ choices: [{ message: { content: 'Paid by [PERSON_1]. [P1]' }, finish_reason: 'stop' }], usage: null });
      return { ok: true, status: 200, text: async () => out };
    };
    const browserCfg = { relayUrl: 'https://noai.example/api/chat', model: 'nvidia/nemotron-3-super-120b-a12b', maxTokens: 4096, maxPayloadBytes: 8000 };
    const r = (await webRespond(v, browserCfg, 'Who paid the deposit for the flat?', { transport, k: 1 })) as { answer: string };
    assert.ok(!sent[0]!.includes('Zorbek'), 'a name the vault knows left the browser');
    assert.match(r.answer, /Zorbek/);
  });
});

describe('what a known name does not swallow', () => {
  it('leaves a place named after a known person alone', () => {
    const r = redactAll(['My friend Fahd called.', 'Meet on King Fahd Road.']);
    assert.deepEqual(r.texts, ['My friend [PERSON_1] called.', 'Meet on King Fahd Road.']);
  });

  it('hides a contact called Will Smith, and leaves the word "will" alone', () => {
    const r = redactAll(['Will Smith said he will call. Smith is late.'], { people: ['Will Smith'] });
    assert.equal(r.texts[0], '[PERSON_1] said he will call. [PERSON_1] is late.');
    assert.equal(rehydrate(r.texts[0]!, r.map), 'Will Smith said he will call. Will Smith is late.');
  });

  it('LIMIT: a name the vault never points at and no contact holds still leaves the device', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'House', 'Zorvath fixed the roof on 22 November.');
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'When did Zorvath fix the roof?', 1, transport);
    assert.ok(sent[0]!.includes('Zorvath'));
  });
});

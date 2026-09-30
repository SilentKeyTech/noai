/**
 * Import: what a WhatsApp export, a Markdown file or a PDF becomes in the
 * vault, and proof that an import sends nothing while a question about the
 * imported file sends only redacted passages.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ask } from '../src/agent.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { importFile, readForImport } from '../src/importer.ts';
import { chatNameFrom, ingestText, layoutPdfItems, looksLikeWhatsApp, newOnly, parseText, parseWhatsApp } from '../src/ingest.ts';
import { readLedger } from '../src/ledger.ts';
import { createVault, readNotes } from '../src/vault.ts';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const PASS = 'a passphrase used only by this test';
const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'noai-ingest-'));
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

const ANDROID = [
  '12/10/2026, 09:14 - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
  '12/10/2026, 09:15 - Sami Haddad: Can you send me the rent receipt?',
  '12/10/2026, 09:16 - Ramzi: Sure, tonight',
  'and the water bill too',
  '12/10/2026, 21:02 - Ramzi: <Media omitted>',
  '13/10/2026, 8:05 PM - Sami Haddad: Thanks, got both',
].join('\n');

const IPHONE = ['\u200e[12/10/2026, 09:15:02] Nour: Dentist moved to Thursday 4pm', '[12/10/2026, 09:15:40] Nour: \u200eimage omitted'].join('\r\n');

const ARABIC = ['١٢/١٠/٢٠٢٦، ٢:٠٣ م - سامي: الإيجار ٣٠٠٠ ريال', '١٢/١٠/٢٠٢٦، ٩:١٠ ص - ريم: تمام'].join('\n');

describe('WhatsApp exports', () => {
  it('Android: one note per day, system lines and media left out, a message over two lines kept whole', () => {
    assert.ok(looksLikeWhatsApp(ANDROID));
    const r = parseWhatsApp(ANDROID, 'Sami Haddad');
    assert.deepEqual(
      r.notes.map((n) => n.title),
      ['WhatsApp with Sami Haddad, 12/10/2026', 'WhatsApp with Sami Haddad, 13/10/2026'],
    );
    assert.equal(r.notes[0]!.body, '09:15 Sami Haddad: Can you send me the rent receipt?\n09:16 Ramzi: Sure, tonight\nand the water bill too');
    assert.equal(r.notes[1]!.body, '20:05 Sami Haddad: Thanks, got both');
    assert.ok(!r.notes.some((n) => /encrypted|omitted/.test(n.body)));
    assert.match(r.warnings.join(' '), /1 media or deleted/);
  });

  it('iPhone: brackets, seconds, direction marks and Windows line ends', () => {
    const r = parseWhatsApp(IPHONE, 'Nour');
    assert.equal(r.notes.length, 1);
    assert.equal(r.notes[0]!.body, '09:15 Nour: Dentist moved to Thursday 4pm');
  });

  it('Arabic locale: Arabic digits and ص/م times', () => {
    const r = parseWhatsApp(ARABIC, 'سامي');
    assert.equal(r.notes[0]!.title, 'WhatsApp with سامي, 12/10/2026');
    assert.equal(r.notes[0]!.body, '14:03 سامي: الإيجار ٣٠٠٠ ريال\n09:10 ريم: تمام');
  });

  it('takes the chat name from the export file name', () => {
    assert.equal(chatNameFrom('WhatsApp Chat with Sami Haddad.txt'), 'Sami Haddad');
    assert.equal(chatNameFrom('C:/exports/WhatsApp Chat - Family.txt'), 'Family');
  });
});

describe('text and Markdown', () => {
  it('a Markdown file becomes one note per heading; plain text becomes one note', () => {
    const md = parseText('# Health\nPenicillin allergy.\n\n## Car\nInsurance renews in March.\n', 'life.md');
    assert.deepEqual(md.notes, [
      { title: 'life: Health', body: 'Penicillin allergy.' },
      { title: 'life: Car', body: 'Insurance renews in March.' },
    ]);
    assert.deepEqual(ingestText('Rent is 850 USD.', 'money.txt').notes, [{ title: 'money', body: 'Rent is 850 USD.' }]);
  });

  it('importing the same thing twice adds nothing', () => {
    const drafts = [{ title: 'a', body: 'b' }, { title: 'a', body: 'b' }, { title: 'c', body: 'd' }];
    assert.deepEqual(newOnly(drafts, [{ title: 'c', body: 'd' }]), [{ title: 'a', body: 'b' }]);
  });
});

describe('PDF', () => {
  it('reads an English bill', async () => {
    const r = await readForImport(fixture('bill.pdf'));
    assert.equal(r.notes[0]!.title, 'bill');
    assert.equal(r.notes[0]!.body, 'Alfa Mobile Invoice\nCustomer: Sami Haddad\nAmount due: 42.50 USD by 15 October 2026\nPay to IBAN LB62 0999 0000 0001 0019 0122 9114');
  });

  it('reads Arabic drawn one glyph at a time, in reading order, as searchable letters', async () => {
    const r = await readForImport(fixture('letter-ar.pdf'));
    assert.equal(r.notes[0]!.body, 'عقد إيجار\nالمستأجر: سامي الزهراني\nالإيجار الشهري ٣٠٠٠ ريال، يدفع في أول كل شهر.\nرقم الجوال ٠٥٥١٢٣٤٥٦٧');
  });

  it('says plainly when a PDF has no text layer, and imports nothing', async () => {
    const r = await readForImport(fixture('scan.pdf'));
    assert.equal(r.notes.length, 0);
    assert.match(r.warnings[0]!, /no text layer/);
  });

  it('keeps a number left to right inside a right-to-left line', () => {
    // Visual order, left to right: "٠٠٣ ريال" drawn as the digits then the word.
    const items = [
      { str: '٣', x: 0, y: 100, w: 5, h: 10 },
      { str: '٠', x: 5, y: 100, w: 5, h: 10 },
      { str: '٠', x: 10, y: 100, w: 5, h: 10 },
      { str: 'ريال', x: 20, y: 100, w: 20, h: 10 },
    ];
    assert.equal(layoutPdfItems(items), 'ريال ٣٠٠');
  });
});

describe('import into the vault', () => {
  it('seals the notes, sends nothing, and a second import adds nothing', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    const file = join(root, 'WhatsApp Chat with Sami Haddad.txt');
    await writeFile(file, ANDROID);
    const first = await importFile(v, file);
    assert.deepEqual([first.format, first.added, first.alreadyThere], ['whatsapp', 2, 0]);
    const again = await importFile(v, file);
    assert.deepEqual([again.added, again.alreadyThere], [0, 2]);
    assert.equal(readNotes(v).length, 2);
    assert.equal((await readLedger(root)).length, 0);
  });

  it('a question about an imported bill sends the amount, not the IBAN or the customer name', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await importFile(v, fixture('bill.pdf'));
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'How much is the Alfa invoice and when is it due?', 3, transport);
    const body = sent[0]!;
    assert.ok(body.includes('42.50 USD') && body.includes('15 October 2026'));
    for (const s of ['LB62', 'Sami', 'Haddad']) assert.ok(!body.includes(s), `${s} left the device`);
  });

  it('a question about an imported Arabic lease hides the tenant and the phone', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await importFile(v, fixture('letter-ar.pdf'));
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'كم الإيجار الشهري؟', 3, transport);
    const body = sent[0]!;
    assert.ok(body.includes('٣٠٠٠ ريال'));
    for (const s of ['سامي', 'الزهراني', '٠٥٥١٢٣٤٥٦٧']) assert.ok(!body.includes(s), `${s} left the device`);
  });
});

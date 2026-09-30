import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ask } from '../src/agent.ts';
import { sha256 } from '../src/crypto.ts';
import { type GateConfig, stripThinking, type Transport } from '../src/gate.ts';
import { ledgerPath, readLedger, readReceipts, verifyLedger } from '../src/ledger.ts';
import { redact, redactAll, rehydrate } from '../src/redact.ts';
import { Bm25Retriever, chunkNote } from '../src/retrieve.ts';
import { addNote, createVault, openVault, readDisclosure, readNotes } from '../src/vault.ts';

// These tests pin BM25 so their disclosure assertions do not depend on whether
// the embedding model is installed. test/memory.test.ts covers the hybrid path.
process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'noai-'));
  dirs.push(d);
  return d;
}
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PASS = 'correct horse battery staple';

/** A stand-in for Token Factory that records exactly what it was sent. */
function fakeNebius(reply: string, finish = 'stop'): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  const transport: Transport = async (_url, init) => {
    sent.push(init.body);
    const out = JSON.stringify({
      choices: [{ message: { content: reply }, finish_reason: finish }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    });
    return { ok: true, status: 200, text: async () => out };
  };
  return { transport, sent };
}

const cfg = (root: string): GateConfig => ({
  root,
  baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  apiKey: 'test-key',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  maxPayloadBytes: 8000,
  maxTokens: 4096,
});

describe('redaction', () => {
  it('replaces emails, phones, IBANs and cards, and rehydrates locally', () => {
    const r = redact('Mail sami@example.com or call +961 70 123 456. IBAN LB62 0999 0000 0001 0019 0122 9114. Card 4111 1111 1111 1111.');
    assert.ok(!r.text.includes('sami@example.com'));
    assert.ok(!r.text.includes('123 456'));
    assert.ok(!r.text.includes('LB62'));
    assert.ok(!r.text.includes('4111'));
    assert.deepEqual(r.counts, { EMAIL: 1, IBAN: 1, CARD: 1, PHONE: 1 });
    assert.equal(rehydrate(r.text, r.map), 'Mail sami@example.com or call +961 70 123 456. IBAN LB62 0999 0000 0001 0019 0122 9114. Card 4111 1111 1111 1111.');
  });

  it('leaves dates and ordinary numbers alone', () => {
    const r = redact('Rent is 850 USD on the 3rd. Review on 30 October 2026.');
    assert.deepEqual(r.counts, {});
  });

  it('leaves digit dates alone, which look like phone numbers but are not', () => {
    const r = redact('Appointment on 2026-10-12, renewal 12/10/2026, check 12.10.2026, call +961 1 345 678.');
    assert.deepEqual(r.counts, { PHONE: 1 });
    assert.ok(r.text.includes('2026-10-12') && r.text.includes('12/10/2026') && r.text.includes('12.10.2026'));
  });
});

describe('redaction of names and Saudi identifiers', () => {
  const roundTrip = (input: string): ReturnType<typeof redact> => {
    const r = redact(input);
    assert.equal(rehydrate(r.text, r.map), input);
    return r;
  };

  it('hides a name everywhere in one disclosure, under one placeholder, even when written short', () => {
    const r = redactAll(['When is Sami birthday?', 'My brother Sami Haddad turns 30 on 22 November.']);
    const [q = '', p = ''] = r.texts;
    assert.ok(!q.includes('Sami') && !p.includes('Sami') && !p.includes('Haddad'));
    assert.equal(q, 'When is [PERSON_1] birthday?');
    assert.equal(p, 'My brother [PERSON_1] turns 30 on 22 November.');
    assert.deepEqual(r.counts, { PERSON: 1 });
  });

  it('takes a name that is not on the list when a title or relation points at it', () => {
    const r = roundTrip('GP is Dr. Zeferino Okafor. My lawyer is Brannigan. My landlord, Quist, wants rent.');
    for (const s of ['Zeferino', 'Okafor', 'Brannigan', 'Quist']) assert.ok(!r.text.includes(s), s);
    assert.deepEqual(r.counts, { PERSON: 3 });
  });

  it('follows name chains: Abu, bin, Al-', () => {
    const r = roundTrip('Abu Omar met Fahad bin Salman Al-Otaibi at noon.');
    assert.equal(r.text, '[PERSON_1] met [PERSON_2] at noon.');
  });

  it('hides Arabic names with the family name, and a phone number written in Arabic digits', () => {
    const r = roundTrip('أخي سامي الزهراني رقمه ٠٥٥١٢٣٤٥٦٧');
    assert.equal(r.text, 'أخي [PERSON_1] رقمه [PHONE_1]');
    assert.deepEqual(r.counts, { PHONE: 1, PERSON: 1 });
  });

  it('finds an Arabic name with a prefix attached, and after a title', () => {
    const r = roundTrip('اتصل بمحمد غدا، وموعدي مع الدكتورة رزان العتيبي.');
    assert.equal(r.text, 'اتصل ب[PERSON_1] غدا، وموعدي مع الدكتورة [PERSON_2].');
  });

  it('hides Saudi national ID and Iqama numbers, Saudi IBANs and Saudi phone formats', () => {
    const r = roundTrip('ID 1012345678, Iqama 2123456789, IBAN SA03 8000 0000 6080 1016 7519, mobile 0551234567 or +966 55 123 4567.');
    for (const s of ['1012345678', '2123456789', 'SA03', '0551234567', '123 4567']) assert.ok(!r.text.includes(s), s);
    assert.deepEqual(r.counts, { IBAN: 1, ID: 2, PHONE: 2 });
  });

  it('leaves words that are also names alone, when nothing marks them as a name', () => {
    assert.deepEqual(redact('Will you mark the bill in May? The grace period ends Friday.').counts, {});
    assert.deepEqual(redact('زوجتي قالت إن الموعد غدا في المستشفى').counts, {});
  });

  it('keeps places named after people, and hides passport numbers', () => {
    assert.deepEqual(redact('The King Fahd Road office, near Prince Sultan University.').counts, {});
    assert.deepEqual(redact('موعد في مستشفى الملك فيصل، شارع الأمير محمد').counts, {});
    const r = roundTrip('Passport N1234567 expires March 2029. Ask Hassan.');
    assert.equal(r.text, 'Passport [PASSPORT_1] expires March 2029. Ask [PERSON_1].');
  });

  it('gives a shared family name its own placeholder instead of guessing whose it is', () => {
    const r = roundTrip('Nour Haddad and Sami Haddad came. The Haddad house is blue.');
    assert.ok(!r.text.includes('Haddad'));
    assert.deepEqual(r.counts, { PERSON: 3 });
  });

  it('always hides the people the owner lists, in any script', () => {
    const r = roundTrip('Zorvath and زكرياوي fixed the roof.');
    assert.deepEqual(r.counts, {});
    const listed = redact('Zorvath and زكرياوي fixed the roof.', { people: ['Zorvath', 'زكرياوي'] });
    assert.equal(listed.text, '[PERSON_1] and [PERSON_2] fixed the roof.');
  });
});

describe('retrieval runs on device', () => {
  it('ranks the right note first', () => {
    const notes = [
      { id: 'a', title: 'Travel', body: 'Passport expires in November 2027.', addedAt: '' },
      { id: 'b', title: 'Family', body: 'Sami turns 30 on 22 November. His number is below.', addedAt: '' },
    ];
    const hits = new Bm25Retriever(notes).search('when is sami birthday', 2);
    assert.equal(hits[0]?.chunk.noteId, 'b');
  });

  it('chunks by paragraph so disclosure is one passage, not one note', () => {
    const body = `First para.\n\nSecond para.\n\n${'Long sentence here. '.repeat(40)}`;
    const chunks = chunkNote({ id: 'x', title: 't', body, addedAt: '' });
    assert.equal(chunks[0]?.text, 'First para.');
    assert.equal(chunks[1]?.text, 'Second para.');
    assert.ok(chunks.length > 3 && chunks.every((c) => c.text.length <= 400));
  });
});

describe('vault', () => {
  it('stores nothing readable on disk and refuses a wrong passphrase', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Secret title', 'Penicillin allergy');
    const raw = await readFile(join(root, 'vault.json'), 'utf8');
    assert.ok(!raw.includes('Penicillin') && !raw.includes('Secret title'));
    await assert.rejects(openVault(root, 'wrong'), /does not open/);
    const again = await openVault(root, PASS);
    assert.equal(readNotes(again)[0]?.body, 'Penicillin allergy');
  });
});

describe('the gate', () => {
  it('sends only redacted text, and the receipt hash matches the exact bytes sent', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November. Sami number +961 70 123 456.');
    await addNote(v, 'Health', 'Penicillin allergy.');
    const { transport, sent } = fakeNebius('<think>check P1</think>Sami turns 30 on 22 November, call [PHONE_1]. [P1]');
    const r = await ask(v, cfg(root), 'When is Sami birthday and what is his number?', 3, transport);

    assert.equal(sent.length, 1);
    const body = sent[0] as string;
    assert.ok(!body.includes('123 456'), 'the phone number left the device');
    assert.ok(!body.includes('Penicillin'), 'an irrelevant note left the device');
    assert.equal(r.signed.receipt.payloadHash, sha256(body));
    assert.equal(r.signed.receipt.payloadBytes, Buffer.byteLength(body));
    assert.ok(!body.includes('Sami'), 'the name left the device');
    assert.deepEqual(r.signed.receipt.redactions, { PHONE: 1, PERSON: 1 });
    assert.equal(r.answer, 'Sami turns 30 on 22 November, call +961 70 123 456. [P1]');
    assert.equal(readDisclosure(v, r.signed.receipt.receiptId), r.disclosed);
  });

  it('refuses a payload over the ceiling and sends nothing', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Long', 'word '.repeat(4000));
    const { transport, sent } = fakeNebius('x');
    await assert.rejects(ask(v, { ...cfg(root), maxPayloadBytes: 500 }, 'word', 3, transport), /ceiling/);
    assert.equal(sent.length, 0);
    assert.equal((await readLedger(root)).length, 0);
  });

  it('treats a truncated reasoning reply as a failure but still receipts the disclosure', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const { transport } = fakeNebius('Let me think about Sami and', 'length');
    await assert.rejects(ask(v, cfg(root), 'Sami birthday', 3, transport), /token budget/);
    assert.equal((await readLedger(root)).length, 1);
  });

  it('strips inline reasoning', () => {
    assert.equal(stripThinking('<think>a\nb</think>\n\nAnswer.'), 'Answer.');
    assert.equal(stripThinking('Answer.'), 'Answer.');
  });
});

describe('the ledger', () => {
  it('verifies, then breaks at the exact entry that was edited', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const { transport } = fakeNebius('22 November. [P1]');
    for (let i = 0; i < 3; i++) await ask(v, cfg(root), 'Sami birthday', 3, transport);

    let verdict = verifyLedger(await readLedger(root), await readReceipts(root));
    assert.equal(verdict.valid, true);
    assert.equal(verdict.length, 3);

    const lines = (await readFile(ledgerPath(root), 'utf8')).split('\n').filter(Boolean);
    const e = JSON.parse(lines[1] as string) as { payloadBytes: number };
    e.payloadBytes = 10;
    lines[1] = JSON.stringify(e);
    await writeFile(ledgerPath(root), `${lines.join('\n')}\n`);

    verdict = verifyLedger(await readLedger(root), await readReceipts(root));
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 1);
  });

  it('catches a deleted disclosure', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const { transport } = fakeNebius('22 November.');
    for (let i = 0; i < 3; i++) await ask(v, cfg(root), 'Sami birthday', 3, transport);
    const lines = (await readFile(ledgerPath(root), 'utf8')).split('\n').filter(Boolean);
    lines.splice(1, 1);
    await writeFile(ledgerPath(root), `${lines.join('\n')}\n`);
    const verdict = verifyLedger(await readLedger(root), await readReceipts(root));
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 1);
  });
});

describe('structure', () => {
  it('only gate.ts touches the network', () => {
    const src = new URL('../src/', import.meta.url);
    // Outbound capability of any kind. server.ts and mcp-serve.ts may import node:http, but only to listen.
    const outbound = /\bfetch\s*\(|node:https['"]|node:net['"]|node:tls['"]|node:dgram['"]|XMLHttpRequest|WebSocket|\bhttp\.(?:request|get)\b|\bundici\b/;
    const offenders = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && f !== 'gate.ts')
      .filter((f) => {
        const code = readFileSync(new URL(f, src), 'utf8');
        if (outbound.test(code)) return true;
        return f !== 'server.ts' && f !== 'mcp-serve.ts' && /node:http['"]/.test(code);
      });
    assert.deepEqual(offenders, []);
  });

  it('shares crypto.ts byte for byte with BurnKey', { skip: !existsSync('C:/BurnKey/burnkey-core/src/crypto.ts') }, () => {
    const ours = readFileSync(new URL('../src/crypto.ts', import.meta.url));
    const theirs = readFileSync('C:/BurnKey/burnkey-core/src/crypto.ts');
    assert.equal(sha256(ours), sha256(theirs));
  });
});

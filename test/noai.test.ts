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
import { redact, rehydrate } from '../src/redact.ts';
import { Bm25Retriever, chunkNote } from '../src/retrieve.ts';
import { addNote, createVault, openVault, readDisclosure, readNotes } from '../src/vault.ts';

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
    assert.deepEqual(r.signed.receipt.redactions, { PHONE: 1 });
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
    // Outbound capability of any kind. server.ts may import node:http, but only to listen.
    const outbound = /\bfetch\s*\(|node:https['"]|node:net['"]|node:tls['"]|node:dgram['"]|XMLHttpRequest|WebSocket|\bhttp\.(?:request|get)\b|\bundici\b/;
    const offenders = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && f !== 'gate.ts')
      .filter((f) => {
        const code = readFileSync(new URL(f, src), 'utf8');
        if (outbound.test(code)) return true;
        return f !== 'server.ts' && /node:http['"]/.test(code);
      });
    assert.deepEqual(offenders, []);
  });

  it('shares crypto.ts byte for byte with BurnKey', { skip: !existsSync('C:/BurnKey/burnkey-core/src/crypto.ts') }, () => {
    const ours = readFileSync(new URL('../src/crypto.ts', import.meta.url));
    const theirs = readFileSync('C:/BurnKey/burnkey-core/src/crypto.ts');
    assert.equal(sha256(ours), sha256(theirs));
  });
});

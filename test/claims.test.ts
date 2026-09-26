/**
 * The privacy claims, one test each, including the ones that prove a LIMIT.
 * A claim that NOAI does not make is tested too, so the report can show it
 * with evidence rather than a disclaimer. Run: node --test test/claims.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ask } from '../src/agent.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { ledgerPath, readLedger, readReceipts, receiptsPath, verifyLedger } from '../src/ledger.ts';
import { addNote, createVault, openVault, readNotes } from '../src/vault.ts';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'noai-claims-'));
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

describe('C1 the vault at rest', () => {
  it('C1.1 holds no note text, no title and no passphrase', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Health', 'Penicillin allergy. GP Dr. Nour Haddad.');
    const raw = await readFile(join(root, 'vault.json'), 'utf8');
    for (const s of ['Penicillin', 'Haddad', 'Health', PASS]) assert.ok(!raw.includes(s), `found "${s}" in vault.json`);
  });

  it('C1.2 a wrong passphrase opens nothing', async () => {
    const root = await tmp();
    await createVault(root, PASS);
    await assert.rejects(openVault(root, `${PASS}x`), /does not open/);
  });

  it('C1.3 an altered ciphertext is refused, not decrypted to garbage', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    const n = await addNote(v, 'Money', 'Rent is 850 USD.');
    const path = join(root, 'vault.json');
    const data = JSON.parse(await readFile(path, 'utf8')) as { notes: Record<string, { sealed: { ct: string } }> };
    const ct = data.notes[n.id]!.sealed.ct;
    data.notes[n.id]!.sealed.ct = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    await writeFile(path, JSON.stringify(data));
    assert.throws(() => readNotes(v === undefined ? v : { ...v, data: data as never }));
  });

  it('C1.4 a sealed note cannot be moved under another note id', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    const a = await addNote(v, 'A', 'first');
    const b = await addNote(v, 'B', 'second');
    const swapped = structuredClone(v.data);
    swapped.notes[a.id]!.sealed = v.data.notes[b.id]!.sealed;
    assert.throws(() => readNotes({ ...v, data: swapped }));
  });
});

describe('C2 what leaves the device', () => {
  const secrets = {
    email: 'sami.haddad@example.com',
    phone: '+961 70 123 456',
    iban: 'LB62 0999 0000 0001 0019 0122 9114',
    card: '4111 1111 1111 1111',
    ip: '192.168.1.1',
    apiKey: 'sk-live-abcdefghijklmnopqrstuvwx',
  };

  it('C2.1 every structured identifier is replaced before sending', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Contacts', `Sami email ${secrets.email}, phone ${secrets.phone}, IBAN ${secrets.iban}, card ${secrets.card}, router ${secrets.ip}, key ${secrets.apiKey}.`);
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'What are Sami email phone IBAN card router and key?', 3, transport);
    for (const [kind, value] of Object.entries(secrets)) assert.ok(!sent[0]!.includes(value), `${kind} left the device`);
  });

  it('C2.2 notes unrelated to the question are not sent at all', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    await addNote(v, 'Health', 'Penicillin allergy.');
    await addNote(v, 'Money', 'Rent is 850 USD on the 3rd.');
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'When is Sami birthday?', 3, transport);
    assert.ok(!sent[0]!.includes('Penicillin') && !sent[0]!.includes('850 USD'));
  });

  it('C2.3 nothing is sent when the key is missing, and nothing is receipted as sent', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const { transport, sent } = capture();
    await assert.rejects(ask(v, { ...cfg(root), apiKey: '' }, 'Sami birthday', 3, transport), /Nothing was sent/);
    assert.equal(sent.length, 0);
    assert.equal((await readLedger(root)).length, 0);
  });
});

describe('C3 the record of what left', () => {
  it('C3.1 a forged receipt, re-hashed to look consistent, still fails its signature', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    await ask(v, cfg(root), 'Sami birthday', 3, capture().transport);
    const lines = (await readFile(receiptsPath(root), 'utf8')).split('\n').filter(Boolean);
    const r = JSON.parse(lines[0]!) as { receipt: { payloadBytes: number } };
    r.receipt.payloadBytes = 12;
    await writeFile(receiptsPath(root), `${JSON.stringify(r)}\n`);
    const verdict = verifyLedger(await readLedger(root), await readReceipts(root));
    assert.equal(verdict.valid, false);
    assert.match(verdict.reason, /signature|does not match/);
  });

  it('C3.2 the chain cannot be truncated at the end without the receipts disagreeing', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    for (let i = 0; i < 3; i++) await ask(v, cfg(root), 'Sami birthday', 3, capture().transport);
    const lines = (await readFile(ledgerPath(root), 'utf8')).split('\n').filter(Boolean);
    await writeFile(ledgerPath(root), `${lines.slice(0, 2).join('\n')}\n`);
    const verdict = verifyLedger(await readLedger(root), await readReceipts(root));
    assert.equal(verdict.valid, false);
  });
});

describe('L the limits, proved rather than asserted', () => {
  it('L1 names, dates and free text DO leave the device', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'My brother Sami turns 30 on 22 November.');
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'When is Sami birthday?', 3, transport);
    for (const s of ['Sami', '22 November', 'brother']) assert.ok(sent[0]!.includes(s), `expected "${s}" to be sent`);
  });

  it('L2 a number written out in words is not recognised as a number', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami number is seven zero one two three four five six.');
    const { transport, sent } = capture();
    await ask(v, cfg(root), 'What is Sami number?', 3, transport);
    assert.ok(sent[0]!.includes('seven zero one two three four five six'));
  });

  it('L3 a receipt proves what was sent, and says nothing about what the provider does next', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const r = await ask(v, cfg(root), 'Sami birthday', 3, capture().transport);
    assert.match(r.signed.receipt.statement, /This device sent exactly the payload/);
    assert.ok(!/delete|retain|store/i.test(r.signed.receipt.statement));
  });
});

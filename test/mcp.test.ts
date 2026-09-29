import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sha256 } from '../src/crypto.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { ledgerPath, readLedger, readReceipts, verifyLedger } from '../src/ledger.ts';
import { type McpContext, revealOnly } from '../src/mcp.ts';
import { createMcpServer } from '../src/mcp-serve.ts';
import { addNote, createVault, readDisclosure, readNotes } from '../src/vault.ts';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const TOKEN = 'test-token-0123456789abcdefghij';
const dirs: string[] = [];
const closers: (() => void)[] = [];
after(async () => {
  for (const c of closers) c();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function cfg(root: string): GateConfig {
  return { root, baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'test-key', model: 'nvidia/nemotron-3-super-120b-a12b', maxPayloadBytes: 8000, maxTokens: 512 };
}

/** Stand-in for Token Factory that records exactly what it was sent. */
function fakeNebius(reply: string): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  const transport: Transport = async (_url, init) => {
    sent.push(init.body);
    const out = JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    return { ok: true, status: 200, text: async () => out };
  };
  return { transport, sent };
}

async function setup(reply: string, reveal: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'noai-mcp-'));
  dirs.push(root);
  const vault = await createVault(root, 'correct horse battery staple');
  await addNote(vault, 'Health: GP', 'GP is Dr. Nour Haddad at the Hamra clinic, phone +961 1 345 678.');
  await addNote(vault, 'Money: rent', 'Landlord IBAN LB62 0999 0000 0001 0019 0122 9114.');
  const nebius = fakeNebius(reply);
  const ctx: McpContext = { vault, cfg: cfg(root), reveal, transport: nebius.transport, embedder: null };
  const server = createMcpServer({ ctx, token: TOKEN, allowedOrigins: ['https://allowed.example'] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  let session = '';
  let nextId = 1;
  const post = async (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, ...(session ? { 'mcp-session-id': session } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    return (await res.json()) as { result?: any; error?: { code: number; message: string } };
  };
  const init = async (client = 'alexa-plus-test') => {
    const res = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: client, version: '1' } } });
    session = res.headers.get('mcp-session-id') ?? '';
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return res;
  };
  return { root, vault, nebius, url, post, rpc, init };
}

describe('mcp transport', () => {
  it('refuses a missing token, a foreign origin and a call before initialize', async () => {
    const s = await setup('unused');
    const noToken = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noToken.status, 401);
    const foreign = await s.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    const early = await s.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(early.status, 400);
    const get = await fetch(s.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);
  });

  it('initializes, issues a session and lists the four tools', async () => {
    const s = await setup('unused');
    const res = await s.init();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(body.result.protocolVersion, '2025-11-25');
    assert.equal(body.result.serverInfo.name, 'noai');
    assert.ok(res.headers.get('mcp-session-id'));
    const list = await s.rpc('tools/list');
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['ask_noai', 'remember', 'list_reminders', 'verify_disclosures']);
    const unknown = await s.rpc('resources/list');
    assert.equal(unknown.error?.code, -32601);
  });

  it('answers a notification with 202 and no body', async () => {
    const s = await setup('unused');
    await s.init();
    const res = await s.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  });
});

describe('mcp disclosure', () => {
  it('hands the assistant the answer only, with the phone number still a placeholder', async () => {
    const s = await setup('Your GP is Dr. Nour Haddad, phone [PHONE_1] [P1].');
    await s.init();
    const r = await s.rpc('tools/call', { name: 'ask_noai', arguments: { question: 'What is my GP phone number?' } });
    const handed: string = r.result.structuredContent.answer;
    assert.equal(r.result.isError, false);
    assert.equal(handed, 'Your GP is Dr. Nour Haddad, phone [PHONE_1].');
    assert.doesNotMatch(r.result.content[0].text, /345 678/);
    // The passages stay home: nothing from the rent note, and not even the GP note's other text.
    assert.doesNotMatch(r.result.content[0].text, /LB62|Hamra/);
    assert.deepEqual(r.result.structuredContent.withheld, { PHONE: 1 });
    // Nemotron never saw the number either.
    assert.doesNotMatch(s.nebius.sent.join(''), /345 678/);
  });

  it('leaves two receipts on one intact chain: one for Nemotron, one for the assistant', async () => {
    const s = await setup('Your GP is Dr. Nour Haddad, phone [PHONE_1] [P1].');
    await s.init('alexa-plus-test');
    const r = await s.rpc('tools/call', { name: 'ask_noai', arguments: { question: 'What is my GP phone number?' } });
    const entries = await readLedger(s.root);
    const receipts = await readReceipts(s.root);
    assert.equal(entries.length, 2);
    assert.equal(verifyLedger(entries, receipts).valid, true);
    const handover = receipts[1]!.receipt;
    assert.equal(handover.endpoint, 'mcp');
    assert.equal(handover.model, 'mcp:alexa-plus-test');
    assert.equal(handover.payloadHash, sha256(r.result.structuredContent.answer));
    assert.deepEqual(r.result.structuredContent.receipts, { model: 0, handover: 1 });
    // The owner can read back exactly what the assistant was handed.
    assert.equal(readDisclosure(s.vault, handover.receiptId), r.result.structuredContent.answer);
  });

  it('reveals only the kinds the owner allowed', async () => {
    const s = await setup('Call [PHONE_1] or pay [IBAN_1].', ['PHONE']);
    await s.init();
    const r = await s.rpc('tools/call', { name: 'ask_noai', arguments: { question: 'GP phone and landlord IBAN' } });
    assert.match(r.result.structuredContent.answer, /\+961 1 345 678/);
    assert.match(r.result.structuredContent.answer, /\[IBAN_1\]/);
    assert.deepEqual(r.result.structuredContent.withheld, { IBAN: 1 });
  });

  it('remembers without sending anything or writing a receipt', async () => {
    const s = await setup('unused');
    await s.init();
    const r = await s.rpc('tools/call', { name: 'remember', arguments: { fact: 'my dentist is now Dr Rana' } });
    assert.equal(r.result.isError, false);
    assert.equal(s.nebius.sent.length, 0);
    assert.equal((await readLedger(s.root)).length, 0);
    assert.ok(readNotes(s.vault).some((n) => n.kind === 'memory' && n.body === 'my dentist is now Dr Rana'));
  });

  it('lists reminders redacted and receipts the handover', async () => {
    const s = await setup('unused');
    await addNote(s.vault, '2099-01-05', 'Call the clinic on +961 1 345 678', 'reminder');
    await addNote(s.vault, '2000-01-01', 'Long past', 'reminder');
    await s.init();
    const r = await s.rpc('tools/call', { name: 'list_reminders', arguments: {} });
    assert.equal(r.result.content[0].text, '2099-01-05: Call the clinic on [PHONE_1]');
    assert.equal((await readReceipts(s.root))[0]!.receipt.model, 'mcp:alexa-plus-test');
  });

  it('reports a broken chain to the assistant', async () => {
    const s = await setup('Your GP is Dr. Nour Haddad [P1].');
    await s.init();
    await s.rpc('tools/call', { name: 'ask_noai', arguments: { question: 'Who is my GP?' } });
    const ok = await s.rpc('tools/call', { name: 'verify_disclosures', arguments: {} });
    assert.equal(ok.result.structuredContent.valid, true);
    const lines = (await readFile(ledgerPath(s.root), 'utf8')).split('\n').filter(Boolean);
    await writeFile(ledgerPath(s.root), `${lines.slice(1).join('\n')}\n`);
    const bad = await s.rpc('tools/call', { name: 'verify_disclosures', arguments: {} });
    assert.equal(bad.result.isError, true);
    assert.equal(bad.result.structuredContent.valid, false);
  });

  it('restores placeholders by kind only', () => {
    const map = new Map([['[PHONE_1]', '+961 1 345 678'], ['[EMAIL_1]', 'a@b.example']]);
    assert.equal(revealOnly('[PHONE_1] [EMAIL_1]', map, ['EMAIL']), '[PHONE_1] a@b.example');
    assert.equal(revealOnly('[PHONE_1]', map, []), '[PHONE_1]');
  });
});

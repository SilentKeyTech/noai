/**
 * A vault with nothing in it. Every read path must answer with nothing,
 * not with an error: the first question is asked before the first note.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ask, respond } from '../src/agent.ts';
import { answerCheckin, checkinQuestion, routines } from '../src/checkins.ts';
import { type AppState, handleApi } from '../src/dashboard.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { readLedger, readReceipts, verifyLedger } from '../src/ledger.ts';
import { handleRpc, type McpContext, type McpSession } from '../src/mcp.ts';
import { knownPeople, peopleFromNotes } from '../src/people.ts';
import { Bm25Retriever, HybridRetriever } from '../src/retrieve.ts';
import { findSecret, listSecrets, removeSecret, revealSecret } from '../src/secrets.ts';
import { createVault, readDisclosure, readNotes } from '../src/vault.ts';
import type { Embedder } from '../src/vector.ts';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const PASS = 'a passphrase used only by this test';
const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function empty(): Promise<{ root: string; v: Awaited<ReturnType<typeof createVault>> }> {
  const root = await mkdtemp(join(tmpdir(), 'noai-empty-'));
  dirs.push(root);
  return { root, v: await createVault(root, PASS) };
}

const cfg = (root: string): GateConfig => ({ root, baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'test', model: 'nvidia/nemotron-3-super-120b-a12b', maxPayloadBytes: 8000, maxTokens: 512 });

function fakeNebius(reply: string): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  const transport: Transport = async (_u, init) => {
    sent.push(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: null }) };
  };
  return { transport, sent };
}

/** An embedder that never loads a model: enough to run the hybrid ranker over nothing. */
const fakeEmbedder: Embedder = { name: 'fake', embed: async (t) => Float32Array.of(t.length, 1, 0) };

describe('an empty vault', () => {
  it('lists no notes, no people, no secrets, and the file holds nothing but the sealed keys', async () => {
    const { root, v } = await empty();
    assert.deepEqual(readNotes(v), []);
    assert.deepEqual(knownPeople(readNotes(v)), { people: [], same: [] });
    assert.deepEqual(peopleFromNotes([]), []);
    assert.deepEqual(listSecrets(v), []);
    assert.equal(findSecret(v, 'github_token'), null);
    assert.equal(revealSecret(v, 'github_token'), null);
    assert.equal(await removeSecret(v, 'github_token'), false);
    assert.equal(readDisclosure(v, 'nothing'), null);
    assert.deepEqual(await readdir(root), ['vault.json']);
  });

  it('searches to nothing with BM25 and with the hybrid ranker', async () => {
    const { v } = await empty();
    assert.deepEqual(new Bm25Retriever(readNotes(v)).search('who is my doctor?', 3), []);
    assert.deepEqual(await new HybridRetriever(readNotes(v), fakeEmbedder).search('who is my doctor?', 3), []);
  });

  it('answers a question with no passages: the model sees the question alone, the receipt lists no sources', async () => {
    const { root, v } = await empty();
    const nebius = fakeNebius('I have no notes about that.');
    const r = await ask(v, cfg(root), 'When is the rent due?', 3, nebius.transport, null);
    assert.equal(r.answer, 'I have no notes about that.');
    assert.deepEqual([r.candidates, r.used, r.retriever], [0, 0, 'bm25']);
    assert.deepEqual(r.signed.receipt.sources, []);
    assert.equal(nebius.sent.length, 1);
    assert.ok(nebius.sent[0]!.includes('When is the rent due?'));
    const entries = await readLedger(root);
    assert.equal(entries.length, 1);
    assert.equal(verifyLedger(entries, await readReceipts(root)).valid, true);
    assert.equal(readDisclosure(v, r.signed.receipt.receiptId)?.includes('When is the rent due?'), true);
  });

  it('keeps a memory as the first note without sending anything', async () => {
    const { root, v } = await empty();
    const nebius = fakeNebius('unused');
    const r = await respond(v, cfg(root), 'remember that my dentist is on Thursday', nebius.transport, null);
    assert.equal(r.kind, 'memory');
    assert.equal(nebius.sent.length, 0);
    assert.equal(readNotes(v).length, 1);
    assert.deepEqual(await readLedger(root), []);
  });

  it('has no check-ins: no routines, and a check-in question is left to the notes', () => {
    assert.deepEqual(routines([]), []);
    const q = checkinQuestion('Did Maya take her meds today?');
    assert.ok(q);
    assert.equal(answerCheckin(q, [], new Date()), null);
  });

  it('shows an unlocked dashboard with zero keys, no receipts and a valid empty log', async () => {
    const { root, v } = await empty();
    const s: AppState = { root, vault: v, mcpUrl: 'http://127.0.0.1:7792/mcp' };
    const status = await handleApi(s, 'GET', '/status', {});
    assert.equal(status.status, 200);
    assert.deepEqual((status.json as { exists: boolean; unlocked: boolean; keys: number }).keys, 0);
    const secrets = await handleApi(s, 'GET', '/secrets', {});
    assert.deepEqual(secrets.json, { keys: [] });
    const receipts = await handleApi(s, 'GET', '/receipts', {});
    assert.equal(receipts.status, 200);
    const r = receipts.json as { valid: boolean; total: number; signers: string[]; uses: unknown[] };
    assert.deepEqual([r.valid, r.total, r.signers, r.uses], [true, 0, [], []]);
    assert.equal((await handleApi(s, 'GET', '/connect', {})).status, 200);
  });

  it('answers every MCP tool: no reminders, no secrets, an intact empty log, and a question with nothing to disclose', async () => {
    const { root, v } = await empty();
    const nebius = fakeNebius('Nothing saved about that yet.');
    const ctx: McpContext = { vault: v, cfg: cfg(root), reveal: [], transport: nebius.transport, embedder: null, toolset: 'all' };
    const session: McpSession = { client: 'test-client', protocolVersion: '2025-11-25' };
    let id = 0;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await handleRpc(ctx, session, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
      assert.ok(reply && 'result' in reply, JSON.stringify(reply));
      return reply.result as { content: { text: string }[]; isError: boolean; structuredContent?: Record<string, unknown> };
    };
    const listed = await handleRpc(ctx, session, { jsonrpc: '2.0', id: ++id, method: 'tools/list' });
    assert.ok(listed && 'result' in listed);
    assert.equal((listed.result as { tools: unknown[] }).tools.length, 6);

    const reminders = await call('list_reminders');
    assert.deepEqual([reminders.content[0]!.text, reminders.isError], ['No upcoming reminders.', false]);
    const secrets = await call('list_secrets');
    assert.match(secrets.content[0]!.text, /no secrets yet/);
    const verify = await call('verify_disclosures');
    assert.match(verify.content[0]!.text, /^Intact/);
    assert.equal(verify.structuredContent?.length, 0);
    const asked = await call('ask_noai', { question: 'When is the rent due?' });
    assert.equal(asked.isError, false);
    assert.equal(asked.content[0]!.text, 'Nothing saved about that yet.');
    assert.equal(asked.structuredContent?.passagesUsed, 0);
    assert.equal(nebius.sent.length, 1);
  });
});

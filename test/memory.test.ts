import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ask, rememberIntent, respond, splitMemories } from '../src/agent.ts';
import { type Embedder, loadEmbedder, MODEL, modelDir } from '../src/embed.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { readLedger } from '../src/ledger.ts';
import { Bm25Retriever, HybridRetriever } from '../src/retrieve.ts';
import type { Note } from '../src/types.ts';
import { addNote, createVault, forgetNote, openVault, readNotes } from '../src/vault.ts';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'noai-mem-'));
  dirs.push(d);
  return d;
}
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PASS = 'correct horse battery staple';
const cfg = (root: string): GateConfig => ({
  root,
  baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  apiKey: 'test-key',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  maxPayloadBytes: 8000,
  maxTokens: 4096,
});
function fakeNebius(reply: string): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  const transport: Transport = async (_url, init) => {
    sent.push(init.body);
    const out = JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: null });
    return { ok: true, status: 200, text: async () => out };
  };
  return { transport, sent };
}

const demo = JSON.parse(readFileSync(new URL('../demo/notes.json', import.meta.url), 'utf8')) as { title: string; body: string }[];
const demoNotes: Note[] = demo.map((n, i) => ({ id: String(i), title: n.title, body: n.body, addedAt: '' }));
const titleOf = (id: string): string => demoNotes[Number(id)]?.title ?? '';

describe('memory', () => {
  it('recognises something to keep, and leaves questions alone', () => {
    assert.equal(rememberIntent('remember that my GP is now Dr. Rana Khoury'), 'my GP is now Dr. Rana Khoury');
    assert.equal(rememberIntent("Don't forget: the water tank comes on Thursdays now"), 'the water tank comes on Thursdays now');
    assert.equal(rememberIntent('remember when Sami turns 30?'), null);
    assert.equal(rememberIntent('who is my doctor?'), null);
  });

  it('saving a memory sends nothing, writes no ledger entry, and seals it', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    const { transport, sent } = fakeNebius('unused');
    const r = await respond(v, cfg(root), 'remember that my gym locker code is 4471', transport, null);
    assert.equal(r.kind, 'memory');
    assert.equal(sent.length, 0);
    assert.equal((await readLedger(root)).length, 0);
    const raw = await readFile(join(root, 'vault.json'), 'utf8');
    assert.ok(!raw.includes('4471') && !raw.includes('locker'));
    const again = await openVault(root, PASS);
    const m = readNotes(again).find((n) => n.kind === 'memory');
    assert.equal(m?.body, 'my gym locker code is 4471');
  });

  it('keeps what the model asks to remember, with the real values put back on device', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const reply = 'Noted, I will use [PHONE_1] for Sami from now on. [P1]\nREMEMBER: Sami\'s new number is [PHONE_1].';
    const { transport, sent } = fakeNebius(reply);
    const r = await ask(v, cfg(root), 'Sami has a new number, +961 71 555 010. When is his birthday?', 3, transport, null);

    assert.ok(!(sent[0] as string).includes('555 010'), 'the new number left the device');
    assert.ok(!r.answer.includes('REMEMBER'), 'the memory line was shown as part of the answer');
    assert.equal(r.remembered.length, 1);
    assert.equal(r.remembered[0]?.body, "Sami's new number is +961 71 555 010.");
    assert.equal(readNotes(v).filter((n) => n.kind === 'memory').length, 1);
  });

  it('a remembered fact is found by the next question', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await respond(v, cfg(root), 'remember that the new dentist is Dr. Lina at the Verdun clinic', fakeNebius('x').transport, null);
    const hits = new Bm25Retriever(readNotes(v)).search('which clinic is the dentist at', 1);
    assert.match(hits[0]?.chunk.text ?? '', /Verdun/);
  });

  it('forget deletes the sealed entry', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    const r = await respond(v, cfg(root), 'remember that the spare key is with Karam', fakeNebius('x').transport, null);
    assert.equal(r.kind, 'memory');
    if (r.kind !== 'memory') return;
    assert.equal(await forgetNote(v, r.note.id), true);
    assert.equal(readNotes(await openVault(root, PASS)).length, 0);
  });

  it('splits memory lines only at the start of a line', () => {
    const s = splitMemories('Your GP is Dr. Haddad. I will not REMEMBER: anything here.\nREMEMBER: GP moved to Achrafieh.');
    assert.deepEqual(s.facts, ['GP moved to Achrafieh.']);
    assert.equal(s.answer, 'Your GP is Dr. Haddad. I will not REMEMBER: anything here.');
  });
});

const haveModel = existsSync(join(modelDir(), MODEL.onnx));

describe('on-device embeddings', { skip: haveModel ? false : 'run npm run model first' }, () => {
  let emb: Embedder;
  before(async () => {
    const e = await loadEmbedder();
    assert.ok(e, 'model files present but the embedder did not load');
    emb = e;
  });

  it('refuses a model file that does not match its pinned hash', async () => {
    const dir = await tmp();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, MODEL.onnx), 'not a model');
    await writeFile(join(dir, MODEL.vocab), '[PAD]');
    await assert.rejects(loadEmbedder(dir), /pinned SHA-256/);
  });

  it('BM25 alone misses "doctor" against a note that says GP', () => {
    const hits = new Bm25Retriever(demoNotes).search('who is my doctor?', 3);
    assert.equal(hits.length, 0);
  });

  it('hybrid finds the GP for "doctor", and sends nothing from other notes', async () => {
    const hits = await new HybridRetriever(demoNotes, emb).search('who is my doctor?', 6);
    const top = hits[0]?.score ?? 0;
    const chosen = hits.filter((h) => h.score >= top / 3).slice(0, 3);
    assert.match(chosen[0]?.chunk.text ?? '', /GP is Dr\. Nour Haddad/);
    for (const h of chosen) assert.equal(titleOf(h.chunk.noteId), 'Health: allergy and GP');
  });

  it('hybrid keeps BM25 right where embeddings alone were wrong', async () => {
    const hits = await new HybridRetriever(demoNotes, emb).search('when do I pay the landlord', 3);
    assert.match(hits[0]?.chunk.text ?? '', /Rent is 850 USD/);
  });

  it('answers the demo questions with the right note first', async () => {
    const r = new HybridRetriever(demoNotes, emb);
    const cases: [string, RegExp][] = [
      ['what is my doctor phone number', /Nour Haddad/],
      ['am I allergic to any medicine', /Penicillin/],
      ['what is the internet password', /CedarNet/],
      ['when is my brother birthday', /Sami turns 30/],
      ['when does my passport expire', /14 November 2027/],
    ];
    for (const [q, want] of cases) assert.match((await r.search(q, 1))[0]?.chunk.text ?? '', want, q);
  });

  it('the agent reports it used the hybrid retriever', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Health', 'GP is Dr. Nour Haddad at the Hamra clinic.');
    await addNote(v, 'Money', 'Rent is 850 USD, paid on the 3rd.');
    const { transport, sent } = fakeNebius('Dr. Nour Haddad. [P1]');
    const r = await ask(v, cfg(root), 'who is my doctor?', 3, transport, emb);
    assert.equal(r.retriever, 'hybrid');
    assert.ok(!(sent[0] as string).includes('Haddad'), "the doctor's name left the device");
    assert.ok((sent[0] as string).includes('[PERSON_1]'));
    assert.ok(!(sent[0] as string).includes('850 USD'), 'an unrelated note left the device');
  });
});

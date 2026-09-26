import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { respond } from '../src/agent.ts';
import type { GateConfig, Transport } from '../src/gate.ts';
import { readLedger, readReceipts, verifyLedger } from '../src/ledger.ts';
import { FAST_MODEL } from '../src/prompt.ts';
import { detectSkill, SKILLS, splitReminders } from '../src/skills.ts';
import { addNote, createVault, readNotes } from '../src/vault.ts';
// @ts-expect-error plain JS module
import { respond as webRespond } from '../web/app/lib/agent.js';
// @ts-expect-error plain JS module
import { readLedger as webLedger, verifyLedger as webVerify } from '../web/app/lib/ledger.js';
// @ts-expect-error plain JS module
import { memoryStore } from '../web/app/lib/store.js';
// @ts-expect-error plain JS module
import { addNote as webAddNote, createVault as webCreateVault } from '../web/app/lib/vault.js';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'noai-skills-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PASS = 'correct horse battery staple';
const cfg = (root: string): GateConfig => ({ root, baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'test', model: 'nvidia/nemotron-3-super-120b-a12b', maxPayloadBytes: 8000, maxTokens: 4096, fallbackModel: FAST_MODEL, timeoutMs: 200 });

/** Replies in order; 'hang' never answers, a number is an HTTP status. */
function scripted(...replies: (string | number | 'hang')[]): { transport: Transport; sent: { model: string; body: string }[] } {
  const sent: { model: string; body: string }[] = [];
  const transport: Transport = (_url, init) => {
    sent.push({ model: (JSON.parse(init.body) as { model: string }).model, body: init.body });
    const r = replies[sent.length - 1] ?? 'ok';
    if (r === 'hang') {
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (typeof r === 'number') return Promise.resolve({ ok: false, status: r, text: async () => '{"error":"x"}' });
    const out = JSON.stringify({ choices: [{ message: { content: r }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    return Promise.resolve({ ok: true, status: 200, text: async () => out });
  };
  return { transport, sent };
}

describe('skills', () => {
  it('recognises the three skills, and ordinary questions stay questions', () => {
    assert.equal(detectSkill('Draft a message to Sami about his birthday dinner')?.id, 'draft');
    assert.equal(detectSkill('Remind me to renew the passport on 2027-05-01')?.id, 'remind');
    assert.equal(detectSkill('Summarise this bill: Electricite du Liban, 45 USD due 5 Oct')?.id, 'bill');
    assert.equal(detectSkill('When is Sami birthday?'), null);
  });

  it('accepts only real calendar dates from REMIND lines', () => {
    const r = splitReminders('Done.\nREMIND: 2026-10-12 | Schengen visa appointment\nREMIND: 2026-02-30 | impossible date\nREMIND: tomorrow | no date');
    assert.deepEqual(r.reminders, [{ due: '2026-10-12', what: 'Schengen visa appointment' }]);
    assert.equal(r.answer, 'Done.');
  });

  it('a draft goes through the same gate: redacted, receipted, with the task line added', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'My brother Sami turns 30 on 22 November. Sami number +961 70 123 456.');
    const { transport, sent } = scripted('Hi Sami, happy early 30th! Dinner on the 22nd?');
    const r = await respond(v, cfg(root), 'Draft a message to Sami about his birthday dinner', transport, null);
    assert.equal(r.kind, 'answer');
    if (r.kind !== 'answer') return;
    assert.equal(r.skill, 'draft');
    assert.ok(sent[0]!.body.includes('TASK: Write a short message'));
    assert.ok(!sent[0]!.body.includes('123 456'));
    assert.equal((await readLedger(root)).length, 1);
  });

  it('a bill summary sends the bill with its IBAN redacted and no vault passages at all', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Health', 'Penicillin allergy.');
    const { transport, sent } = scripted('EDL, 45 USD, due 5 Oct.');
    await respond(v, cfg(root), 'Summarise this bill: Electricite du Liban, 45 USD due 5 Oct, pay to LB62 0999 0000 0001 0019 0122 9114', transport, null);
    const body = sent[0]!.body;
    assert.ok(!body.includes('LB62') && body.includes('[IBAN_1]'));
    assert.ok(body.includes('(none matched)') && !body.includes('Penicillin'));
  });

  it('a reminder is sealed with its due date, with the real values put back on device', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    const { transport } = scripted('Reminder set.\nREMIND: 2026-10-12 | Call the clinic on [PHONE_1]');
    const r = await respond(v, cfg(root), 'Remind me to call the clinic on +961 1 345 678 on 2026-10-12', transport, null);
    if (r.kind !== 'answer') return assert.fail('expected an answer');
    assert.equal(r.reminders[0]?.title, '2026-10-12');
    assert.equal(r.reminders[0]?.body, 'Call the clinic on +961 1 345 678');
    const raw = await readFile(join(root, 'vault.json'), 'utf8');
    assert.ok(!raw.includes('clinic') && !raw.includes('345 678'));
    assert.equal(readNotes(v).find((n) => n.kind === 'reminder')?.title, '2026-10-12');
  });
});

describe('fallback to Nemotron Nano', () => {
  it('when the main model does not answer in time, Nano answers the same passages, and both attempts are receipted', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const { transport, sent } = scripted('hang', '22 November. [P1]');
    const r = await respond(v, cfg(root), 'When is Sami birthday?', transport, null);
    if (r.kind !== 'answer') return assert.fail('expected an answer');
    assert.equal(r.fellBack, true);
    assert.equal(r.model, FAST_MODEL);
    assert.deepEqual(sent.map((s) => s.model), ['nvidia/nemotron-3-super-120b-a12b', FAST_MODEL]);
    const receipts = await readReceipts(root);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]?.receipt.outcome, 'timeout');
    assert.equal(receipts[1]?.receipt.outcome, undefined);
    assert.equal(verifyLedger(await readLedger(root), receipts).valid, true);
  });

  it('a 5xx falls back; a 400 does not, because a malformed request fails on any model', async () => {
    const root = await tmp();
    const v = await createVault(root, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const five = scripted(503, '22 November.');
    const r = await respond(v, cfg(root), 'Sami birthday?', five.transport, null);
    assert.equal(r.kind === 'answer' && r.fellBack, true);
    const four = scripted(400);
    await assert.rejects(respond(v, cfg(root), 'Sami birthday?', four.transport, null), /returned 400/);
    assert.equal(four.sent.length, 1);
  });

  it('the browser gate falls back the same way, and its chain still verifies', async () => {
    const store = memoryStore();
    const v = await webCreateVault(store, PASS);
    await webAddNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const { transport, sent } = scripted(502, '22 November.');
    const webCfg = { relayUrl: 'https://noai.example/api/chat', model: 'nvidia/nemotron-3-super-120b-a12b', fallbackModel: FAST_MODEL, maxTokens: 4096, maxPayloadBytes: 8000, timeoutMs: 200 };
    const r = await webRespond(v, webCfg, 'When is Sami birthday?', { transport });
    assert.equal(r.fellBack, true);
    assert.equal(sent.length, 2);
    assert.equal(webVerify(await webLedger(store), await store.get('receipts')).valid, true);
  });
});

describe('skill copy stays inside the proven claims', () => {
  it('no skill task asks the model for anything beyond the passages and the question', () => {
    for (const s of Object.values(SKILLS)) assert.ok(!/search the web|browse|look up online/i.test(s.task), s.id);
  });
});

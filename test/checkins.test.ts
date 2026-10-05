/**
 * Family check-ins: said and answered on the device, never sent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answerCheckin, checkinIntent, checkinQuestion, routines, type CheckinNote } from '../src/checkins.ts';
// @ts-expect-error plain JS module
import { respond } from '../web/app/lib/agent.js';
// @ts-expect-error plain JS module
import { readLedger } from '../web/app/lib/ledger.js';
// @ts-expect-error plain JS module
import { memoryStore } from '../web/app/lib/store.js';
// @ts-expect-error plain JS module
import { addNote, createVault, readNotes } from '../web/app/lib/vault.js';

const NOW = new Date(2026, 9, 2, 18, 30);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const ci = (who: string, body: string, addedAt: string): CheckinNote => ({ title: who, body, addedAt, kind: 'checkin' });

describe('check-ins', () => {
  it('reads a short statement as a check-in, and never a question', () => {
    assert.deepEqual(checkinIntent('Maya took her inhaler'), { who: 'Maya', what: 'took her inhaler' });
    assert.deepEqual(checkinIntent('check in: I did my homework.'), { who: 'me', what: 'did my homework' });
    assert.deepEqual(checkinIntent('Omar just got home'), { who: 'Omar', what: 'got home' });
    assert.equal(checkinIntent('Did Maya take her inhaler?'), null);
    assert.equal(checkinIntent('When is Sami birthday'), null);
    assert.equal(checkinIntent('The bank took the rent'), null);
  });

  it('reads a question about a check-in, and when it asks about', () => {
    assert.deepEqual(checkinQuestion('Did Maya take her meds today?'), { who: 'Maya', what: 'take her meds', when: 'today' });
    assert.deepEqual(checkinQuestion('has Omar done his homework yet'), { who: 'Omar', what: 'done his homework', when: 'today' });
    assert.equal(checkinQuestion('Did Maya take her meds yesterday?')?.when, 'yesterday');
    assert.equal(checkinQuestion('What is my brother number?'), null);
  });

  it('finds "meds" in "took her inhaler", within the day asked about', () => {
    const notes = [ci('Maya', 'took her inhaler', at(2, 8, 2)), ci('Maya', 'brushed her teeth', at(2, 8, 10))];
    const yes = answerCheckin(checkinQuestion('Did Maya take her meds today?')!, notes, NOW)!;
    assert.equal(yes.found?.body, 'took her inhaler');
    assert.match(yes.text, /^Yes\. Maya checked in "took her inhaler" today at 08:02\.$/);
  });

  it('says no plainly, with the last time it happened', () => {
    const notes = [ci('Maya', 'took her inhaler', at(1, 8, 5))];
    const no = answerCheckin(checkinQuestion('Did Maya take her meds today?')!, notes, NOW)!;
    assert.equal(no.found, null);
    assert.match(no.text, /^Not today\..*yesterday at 08:05\.$/);
  });

  it('leaves the question to the notes when that person never checked in', () => {
    assert.equal(answerCheckin(checkinQuestion('Did Sami take his meds?')!, [ci('Maya', 'took her inhaler', at(2, 8))], NOW), null);
  });

  it('offers each routine once, newest first', () => {
    const notes = [ci('Maya', 'took her inhaler', at(1, 8)), ci('Maya', 'took her inhaler', at(2, 8)), ci('Omar', 'got home', at(2, 16))];
    assert.deepEqual(routines(notes), [{ who: 'Omar', what: 'got home' }, { who: 'Maya', what: 'took her inhaler' }]);
  });

  it('checks in and answers in the browser with no model call, no bytes and no receipt', async () => {
    const store = memoryStore();
    const v = await createVault(store, 'correct horse battery staple');
    await addNote(v, 'Health', 'Maya uses a blue inhaler, two puffs.');
    const sent: string[] = [];
    const transport = async (_u: string, init: { body: string }) => {
      sent.push(init.body);
      throw new Error('the model was called');
    };
    const cfg = { relayUrl: 'https://noai.example/api/chat', model: 'nvidia/nemotron-3-super-120b-a12b', maxTokens: 512, maxPayloadBytes: 8000 };

    const said = await respond(v, cfg, 'Maya took her inhaler', { transport });
    assert.equal(said.kind, 'checkin');
    assert.equal(said.bytesSent, 0);
    assert.ok(!JSON.stringify(await store.get('vault')).includes('inhaler'), 'the check-in was stored readable');

    const asked = await respond(v, cfg, 'Did Maya take her meds today?', { transport });
    assert.equal(asked.kind, 'checkin-answer');
    assert.match(asked.answer, /^Yes\. Maya checked in "took her inhaler" today at/);
    assert.equal(sent.length, 0);
    assert.equal((await readLedger(store)).length, 0);
    assert.equal((await readNotes(v)).filter((n: { kind: string }) => n.kind === 'checkin').length, 1);
  });
});

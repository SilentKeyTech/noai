/**
 * A model's private notes are dropped from what the person reads, whether the
 * reply comes whole or in pieces cut anywhere, even inside a tag.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dropThinking, ThinkingFilter } from '../src/gate.ts';

const REPLY = '<reasoning>User wants a summary of [COMPANY_1] and [PERSON_1].</reasoning>[COMPANY_1] must give notice within 7 days, 3 < 5.';
const ANSWER = '[COMPANY_1] must give notice within 7 days, 3 < 5.';

describe('thinking filter', () => {
  it('drops <reasoning> and <think> notes from a whole reply', () => {
    assert.equal(dropThinking(REPLY), ANSWER);
    assert.equal(dropThinking('<think>plan</think>\n\nHello'), 'Hello');
    assert.equal(dropThinking('No notes here.'), 'No notes here.');
  });

  it('gives the same answer whatever size the pieces are', () => {
    for (let size = 1; size <= 14; size++) {
      const f = new ThinkingFilter();
      let out = '';
      for (let i = 0; i < REPLY.length; i += size) out += f.push(REPLY.slice(i, i + size));
      out += f.flush();
      assert.equal(out, ANSWER, `pieces of ${String(size)}`);
    }
  });

  it('shows nothing of notes that never close', () => {
    assert.equal(dropThinking('<reasoning>still thinking about [PERSON_1]'), '');
  });

  it('leaves a lone < and other tags alone', () => {
    assert.equal(dropThinking('a <b> c <'), 'a <b> c <');
  });
});

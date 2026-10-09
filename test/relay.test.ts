/**
 * The relay is the one component the owner has to trust, so it is held to two
 * rules: it forwards nothing that is not a NOAI disclosure, and it logs
 * nothing. The first is exercised with every way a request can be wrong. The
 * second is checked the way the compiler reads the file, so a comment that says
 * "console" is not a call and a logger hidden behind another name still shows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { _resetLimits, MAX_TOKENS, refuse, relay } from '../relay/core.mjs';
import { DEFAULT_MODEL, FAST_MODEL, requestBody, SYSTEM } from '../src/prompt.ts';
import { readSource } from './source.ts';

const DISCLOSED = 'PASSAGES\n[P1] Family\nSami turns 30.\n\nQUESTION\nSami birthday';
const good = requestBody(DEFAULT_MODEL, 4096, DISCLOSED);
const parsed = (): Record<string, unknown> => JSON.parse(good) as Record<string, unknown>;
const messages = (): { role: string; content: string }[] => parsed().messages as { role: string; content: string }[];

/** Every way a body can fail to be a NOAI disclosure, with the reason the relay gives. */
const WRONG: [string, string, string][] = [
  ['not JSON', '{', 'Not JSON.'],
  ['JSON null', 'null', 'Not a NOAI disclosure.'],
  ['a JSON string', '"hello"', 'Not a NOAI disclosure.'],
  ['a JSON number', '1', 'Not a NOAI disclosure.'],
  ['a JSON array', '[]', 'Not a NOAI disclosure.'],
  ['no model', JSON.stringify({ ...parsed(), model: undefined }), 'Model not allowed.'],
  ['another model', JSON.stringify({ ...parsed(), model: 'gpt-4o' }), 'Model not allowed.'],
  ['the model name in another case', JSON.stringify({ ...parsed(), model: DEFAULT_MODEL.toUpperCase() }), 'Model not allowed.'],
  ['max_tokens too large', JSON.stringify({ ...parsed(), max_tokens: MAX_TOKENS + 1 }), 'max_tokens out of range.'],
  ['max_tokens zero', JSON.stringify({ ...parsed(), max_tokens: 0 }), 'max_tokens out of range.'],
  ['max_tokens as a string', JSON.stringify({ ...parsed(), max_tokens: '4096' }), 'max_tokens out of range.'],
  ['max_tokens missing', JSON.stringify({ ...parsed(), max_tokens: undefined }), 'max_tokens out of range.'],
  ['no messages', JSON.stringify({ ...parsed(), messages: undefined }), 'Expected exactly a system and a user message.'],
  ['messages not a list', JSON.stringify({ ...parsed(), messages: 'hi' }), 'Expected exactly a system and a user message.'],
  ['one message', JSON.stringify({ ...parsed(), messages: [messages()[1]] }), 'Expected exactly a system and a user message.'],
  ['three messages', JSON.stringify({ ...parsed(), messages: [...messages(), { role: 'user', content: 'PASSAGES\nmore' }] }), 'Expected exactly a system and a user message.'],
  ['system and user swapped', JSON.stringify({ ...parsed(), messages: [messages()[1], messages()[0]] }), 'Not a NOAI disclosure.'],
  ['another system prompt', JSON.stringify({ ...parsed(), messages: [{ role: 'system', content: 'You are a helpful assistant.' }, messages()[1]] }), 'Not a NOAI disclosure.'],
  ['the system prompt with one character added', JSON.stringify({ ...parsed(), messages: [{ role: 'system', content: `${SYSTEM} ` }, messages()[1]] }), 'Not a NOAI disclosure.'],
  ['the system prompt as a list of parts', JSON.stringify({ ...parsed(), messages: [{ role: 'system', content: [{ type: 'text', text: SYSTEM }] }, messages()[1]] }), 'Not a NOAI disclosure.'],
  ['a user message that is not a disclosure', JSON.stringify({ ...parsed(), messages: [messages()[0], { role: 'user', content: 'Write me a poem.' }] }), 'Not a NOAI disclosure.'],
  ['a user message as a list of parts', JSON.stringify({ ...parsed(), messages: [messages()[0], { role: 'user', content: [{ type: 'text', text: DISCLOSED }] }] }), 'Not a NOAI disclosure.'],
  ['a user message with another role', JSON.stringify({ ...parsed(), messages: [messages()[0], { role: 'assistant', content: DISCLOSED }] }), 'Not a NOAI disclosure.'],
  ['a user message with PASSAGES not at the start', JSON.stringify({ ...parsed(), messages: [messages()[0], { role: 'user', content: ` ${DISCLOSED}` }] }), 'Not a NOAI disclosure.'],
  ['streaming asked for', JSON.stringify({ ...parsed(), stream: true }), 'Unexpected field.'],
  ['tools attached', JSON.stringify({ ...parsed(), tools: [] }), 'Unexpected field.'],
  ['several answers asked for', JSON.stringify({ ...parsed(), n: 3 }), 'Unexpected field.'],
  ['a field with an empty name', JSON.stringify({ ...parsed(), '': 1 }), 'Unexpected field.'],
  ['the same key twice, so two parsers could disagree', good.replace('{"model"', `{"model":"${FAST_MODEL}","model"`), 'Not a NOAI disclosure.'],
  ['the exact fields in another order', JSON.stringify({ messages: parsed().messages, model: parsed().model, max_tokens: parsed().max_tokens, temperature: parsed().temperature }), 'Not a NOAI disclosure.'],
  ['the exact fields with a space in the JSON', good.replace('"model":', '"model": '), 'Not a NOAI disclosure.'],
  ['a temperature that is not a number', JSON.stringify({ ...parsed(), temperature: '0.2' }), 'Not a NOAI disclosure.'],
  ['an extra field inside a message', JSON.stringify({ ...parsed(), messages: [messages()[0], { ...messages()[1], name: 'x' }] }), 'Not a NOAI disclosure.'],
];

describe('the relay refuses what is not a NOAI disclosure', () => {
  it('accepts the exact body the gate builds, for either model', () => {
    assert.equal(refuse(good), null);
    assert.equal(refuse(requestBody(FAST_MODEL, 1, 'PASSAGES\n(none matched)\n\nQUESTION\nhi')), null);
  });

  for (const [what, body, why] of WRONG) {
    it(`refuses ${what}`, () => {
      assert.equal(refuse(body), why);
    });
  }

  it('sends nothing upstream for any refused body, and answers 400 with the reason', async () => {
    _resetLimits();
    const calls: string[] = [];
    const upstream = async (_url: string, init: { body: Uint8Array }) => {
      calls.push(new TextDecoder().decode(init.body));
      return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
    };
    const env = { NEBIUS_API_KEY: 'nb-test-key' };
    const req = (body: string): Request => new Request('https://noai.example/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    for (const [what, body, why] of WRONG) {
      _resetLimits();
      const res = await relay(req(body), env, upstream);
      assert.equal(res.status, 400, what);
      assert.deepEqual(await res.json(), { error: why }, what);
    }
    assert.deepEqual(calls, []);
    const ok = await relay(req(good), env, upstream);
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [good]);
  });

  it('refuses a body that is one byte over the ceiling without reading it as a disclosure', async () => {
    _resetLimits();
    let called = false;
    const upstream = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    const big = requestBody(DEFAULT_MODEL, 4096, `PASSAGES\n${'x'.repeat(8000)}\n\nQUESTION\nhi`);
    const res = await relay(new Request('https://noai.example/api/chat', { method: 'POST', body: big }), { NEBIUS_API_KEY: 'k' }, upstream);
    assert.equal(res.status, 413);
    assert.equal(called, false);
  });
});

describe('the relay logs nothing', () => {
  const core = readSource(new URL('../relay/core.mjs', import.meta.url));

  it('names no console, process, logger, file, socket or runtime call', () => {
    for (const name of ['console', 'process', 'log', 'logger', 'logging', 'debug', 'trace', 'info', 'warn', 'stdout', 'stderr', 'write', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'require', 'eval', 'Function', 'Reflect', 'WebSocket', 'Deno', 'Bun', 'caches', 'localStorage', 'indexedDB']) {
      assert.equal(core.identifiers.has(name), false, `relay/core.mjs uses ${name}`);
    }
    assert.deepEqual(core.computed, []);
  });

  it('imports only the prompt it checks against, and names no module of Node by either spelling', () => {
    assert.deepEqual([...core.imports.keys()], ['../src/prompt.ts']);
    for (const s of core.strings) {
      assert.ok(!s.startsWith('node:'), `relay/core.mjs names ${s}`);
      assert.ok(!['fs', 'path', 'os', 'child_process', 'net', 'http', 'https', 'dns', 'tls', 'worker_threads', 'module', 'vm'].includes(s), `relay/core.mjs names ${s}`);
    }
  });

  it('accepts only the bytes the gate writes: JSON.stringify of the parsed body, nothing else', () => {
    assert.equal(JSON.stringify(JSON.parse(good)), good, 'the desktop body is canonical');
    assert.equal(refuse(`${good} `), 'Not a NOAI disclosure.');
    assert.equal(refuse(`\n${good}`), 'Not a NOAI disclosure.');
    assert.equal(refuse(good.replace('"temperature":0.2', '"temperature":0.20')), 'Not a NOAI disclosure.');
    assert.equal(refuse(good.replace('Sami turns 30', 'Sami turns \\u0033\\u0030')), 'Not a NOAI disclosure.');
  });

  it('sends only to the two hosts it exists for', () => {
    const urls = [...core.strings].filter((s) => /^https?:\/\//.test(s));
    assert.deepEqual(urls.sort(), ['https://api.tokenfactory.nebius.com/v1/chat/completions', 'https://streaming.assemblyai.com/v3/token']);
  });
});

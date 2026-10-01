/**
 * The browser build, run in Node against an in-memory store. The same files
 * the page loads, not a copy. npm test builds web/app first (pretest).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { open as nodeOpen, sha256 } from '../src/crypto.ts';
import { MODEL as NODE_MODEL } from '../src/embed.ts';
import { verifyLedger as nodeVerify } from '../src/ledger.ts';
import { requestBody, SYSTEM } from '../src/prompt.ts';
import type { LedgerEntry, SignedDisclosure } from '../src/types.ts';
import { _resetLimits, relay } from '../relay/core.mjs';
// @ts-expect-error plain JS module
import { respond } from '../web/app/lib/agent.js';
// @ts-expect-error plain JS module
import { MODEL as WEB_MODEL } from '../web/app/lib/embedder.js';
// @ts-expect-error plain JS module
import { exportFiles, readLedger, verifyLedger } from '../web/app/lib/ledger.js';
// @ts-expect-error plain JS module
import { memoryStore } from '../web/app/lib/store.js';
// @ts-expect-error plain JS module
import { addNote, createVault, openVault, readNotes, readProfile, saveProfile } from '../web/app/lib/vault.js';
// @ts-expect-error plain JS module
import { randomBytes, seal, utf8 } from '../web/app/lib/wcrypto.js';

const PASS = 'correct horse battery staple';
const cfg = { relayUrl: 'https://noai.example/api/chat', model: 'nvidia/nemotron-3-super-120b-a12b', maxTokens: 4096, maxPayloadBytes: 8000 };

function fakeRelay(reply: string) {
  const sent: string[] = [];
  const transport = async (_url: string, init: { body: string }) => {
    sent.push(init.body);
    const out = JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    return { ok: true, status: 200, text: async () => out };
  };
  return { transport, sent };
}

describe('browser vault', () => {
  it('stores nothing readable and refuses a wrong passphrase', async () => {
    const store = memoryStore();
    const v = await createVault(store, PASS);
    await addNote(v, 'Secret title', 'Penicillin allergy');
    const raw = JSON.stringify(await store.get('vault'));
    assert.ok(!raw.includes('Penicillin') && !raw.includes('Secret title'));
    await assert.rejects(openVault(store, 'wrong passphrase'), /does not open/);
    assert.equal((await readNotes(await openVault(store, PASS)))[0].body, 'Penicillin allergy');
  });

  it('seals what the companion calls the owner, and never retrieves or sends it', async () => {
    const store = memoryStore();
    const v = await createVault(store, PASS);
    await saveProfile(v, { name: 'Layla' });
    assert.ok(!JSON.stringify(await store.get('vault')).includes('Layla'));
    assert.deepEqual(await readProfile(await openVault(store, PASS)), { name: 'Layla' });
    assert.equal((await readNotes(v)).length, 0);
    const { transport, sent } = fakeRelay('Nothing about that. [P1]');
    await addNote(v, 'Health', 'Penicillin allergy.');
    await respond(v, cfg, 'Do I have any allergies?', { transport });
    assert.ok(!sent.join('').includes('Layla'), 'the owner name left the browser');
  });

  it('seals in the same format the desktop opens', async () => {
    const key = randomBytes(32);
    const sealed = await seal(key, utf8('same bytes everywhere'), utf8('note-id'));
    assert.equal(nodeOpen(Buffer.from(key), sealed, Buffer.from('note-id')).toString('utf8'), 'same bytes everywhere');
  });
});

describe('browser gate', () => {
  it('sends only redacted text through the relay, and the receipt verifies with the desktop verifier', async () => {
    const store = memoryStore();
    const v = await createVault(store, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November. Sami number +961 70 123 456.');
    await addNote(v, 'Health', 'Penicillin allergy.');
    const { transport, sent } = fakeRelay('Sami turns 30 on 22 November, call [PHONE_1]. [P1]');
    const r = await respond(v, cfg, 'When is Sami birthday and what is his number?', { transport });

    const body = sent[0] as string;
    assert.ok(!body.includes('123 456'), 'the phone number left the browser');
    assert.ok(!body.includes('Penicillin'), 'an irrelevant note left the browser');
    assert.equal(r.answer, 'Sami turns 30 on 22 November, call +961 70 123 456. [P1]');
    assert.equal(r.signed.receipt.payloadHash, sha256(body));

    // Byte for byte what the desktop gate would have sent for the same disclosure.
    assert.equal(body, requestBody(cfg.model, cfg.maxTokens, r.disclosed));

    // The exported files verify with the desktop code, no browser involved.
    const files = await exportFiles(store);
    const parse = <T>(s: string): T[] => s.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
    const verdict = nodeVerify(parse<LedgerEntry>(files['ledger.jsonl']), parse<SignedDisclosure>(files['receipts.jsonl']));
    assert.equal(verdict.valid, true, verdict.reason);
  });

  it('a memory sends nothing', async () => {
    const store = memoryStore();
    const v = await createVault(store, PASS);
    const { transport, sent } = fakeRelay('x');
    const r = await respond(v, cfg, 'remember that the spare key is with Karam', { transport });
    assert.equal(r.kind, 'memory');
    assert.equal(sent.length, 0);
    assert.equal((await readLedger(store)).length, 0);
  });

  it('a tampered browser ledger breaks at the edited entry', async () => {
    const store = memoryStore();
    const v = await createVault(store, PASS);
    await addNote(v, 'Family', 'Sami turns 30 on 22 November.');
    const { transport } = fakeRelay('22 November.');
    for (let i = 0; i < 3; i++) await respond(v, cfg, 'Sami birthday', { transport });
    const entries = await readLedger(store);
    entries[1].payloadBytes = 10;
    await store.put('ledger', entries);
    const verdict = verifyLedger(await readLedger(store), await store.get('receipts'));
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 1);
  });
});

describe('relay', () => {
  const env = { NEBIUS_API_KEY: 'nb-test-key', NOAI_ALLOWED_ORIGINS: 'https://noai.example' };
  const good = requestBody('nvidia/nemotron-3-super-120b-a12b', 4096, 'PASSAGES\n[P1] Family\nSami turns 30.\n\nQUESTION\nSami birthday');
  const req = (body: string, init: { method?: string; origin?: string } = {}): Request => {
    const method = init.method ?? 'POST';
    const headers = { origin: init.origin ?? 'https://noai.example', 'content-type': 'application/json' };
    return new Request('https://noai.example/api/chat', method === 'POST' ? { method, headers, body } : { method, headers });
  };
  const upstream = () => {
    const calls: { url: string; auth: string; body: string }[] = [];
    const f = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      calls.push({ url, auth: init.headers.authorization ?? '', body: new TextDecoder().decode(init.body) });
      return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
    };
    return { f, calls };
  };

  it('forwards the exact bytes and adds the key, which never comes back', async () => {
    _resetLimits();
    const { f, calls } = upstream();
    const res = await relay(req(good), env, f);
    assert.equal(res.status, 200);
    assert.equal(calls[0]?.body, good);
    assert.equal(calls[0]?.url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
    assert.equal(calls[0]?.auth, 'Bearer nb-test-key');
    assert.ok(!(await res.text()).includes('nb-test-key'));
  });

  it('refuses anything that is not a NOAI disclosure, and sends nothing upstream', async () => {
    _resetLimits();
    const { f, calls } = upstream();
    const other = JSON.parse(good) as { messages: { content: string }[]; model: string };
    const cases: [Request, number][] = [
      [req(good, { method: 'GET' }), 405],
      [req(good, { origin: 'https://evil.example' }), 403],
      [req(JSON.stringify({ ...other, model: 'some/other-model' })), 400],
      [req(JSON.stringify({ ...other, messages: [{ role: 'system', content: 'You are a helpful assistant.' }, other.messages[1]] })), 400],
      [req(JSON.stringify({ ...other, stream: true })), 400],
      [req(good.replace('Sami turns 30.', 'x'.repeat(9000))), 413],
    ];
    for (const [r, status] of cases) assert.equal((await relay(r, env, f)).status, status);
    assert.equal(calls.length, 0);
    assert.ok(SYSTEM.length > 100);
  });

  it('limits a single client', async () => {
    _resetLimits();
    const { f } = upstream();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await relay(req(good), env, f)).status;
    assert.equal(last, 429);
  });

  it('has no logging in it at all', () => {
    const code = readFileSync(new URL('../relay/core.mjs', import.meta.url), 'utf8');
    assert.ok(!/console\.|process\.stdout|writeFile|appendFile/.test(code));
  });
});

describe('browser structure', () => {
  it('only gate.js and voice.js send anything, voice.js only to AssemblyAI and its own token route, and embedder.js only fetches its own model', () => {
    const dir = new URL('../web/app/lib/', import.meta.url);
    const outbound = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/;
    const offenders = readdirSync(dir).filter((f) => f.endsWith('.js') && !['gate.js', 'voice.js', 'embedder.js'].includes(f) && outbound.test(readFileSync(new URL(f, dir), 'utf8')));
    assert.deepEqual(offenders, []);
    const voice = readFileSync(new URL('voice.js', dir), 'utf8');
    assert.deepEqual([...voice.matchAll(/wss:\/\/[^/`'"$]+|\$\{VOICE_HOST\}/g)].map((m) => m[0]), ['${VOICE_HOST}']);
    assert.match(voice, /export const VOICE_HOST = 'streaming\.assemblyai\.com';/);
    assert.deepEqual([...voice.matchAll(/fetch\(([^,)]*)/g)].map((m) => m[1]), ['url']);
    assert.match(voice, /tokenUrl = '\.\/api\/voice-token'/);
    const emb = readFileSync(new URL('embedder.js', dir), 'utf8');
    assert.deepEqual([...emb.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]), ['new URL(path, base']);
    assert.ok(!/method:\s*['"]POST/.test(emb));
  });

  it('the browser pins the same model as the desktop', () => {
    assert.deepEqual(WEB_MODEL, { ...NODE_MODEL });
  });

  it('the page loads no script or style from anywhere else', () => {
    const html = readFileSync(new URL('../web/app/index.html', import.meta.url), 'utf8');
    assert.ok(!/(src|href)=["']https?:/.test(html));
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html), 'inline script would need the CSP loosened');
  });
});

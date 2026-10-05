/**
 * The company gateway. Each test is one claim, made through a real HTTP
 * server on 127.0.0.1 with the provider replaced by a function that records
 * what it was sent. No network.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sha256 } from '../src/crypto.ts';
import { type GatewayConfig, type Transport } from '../src/gate.ts';
import { createGatewayServer, parseTokens } from '../src/gateway-serve.ts';
import { readLedger, readReceipts, verifyLedger } from '../src/ledger.ts';
import { addNote, createVault, readDisclosure } from '../src/vault.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const TOKEN_A = 'amal-secret-0123456789abcdef';
const TOKEN_B = 'omar-secret-0123456789abcdef';

interface Provider {
  transport: Transport;
  sent: string[];
}

/** A provider that records every body and answers with whatever `reply` returns for it. */
function provider(reply: (body: string) => { status?: number; json?: unknown } = () => ({})): Provider {
  const sent: string[] = [];
  const transport: Transport = async (_url, init) => {
    sent.push(init.body);
    const r = reply(init.body);
    const body = JSON.stringify(r.json ?? { id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => body };
  };
  return { transport, sent };
}

/** Echo the user's last message back, so a placeholder in means a placeholder out. */
const echo = (body: string): { json: unknown } => {
  const m = (JSON.parse(body) as { messages: { content: string }[] }).messages.at(-1)?.content ?? '';
  return { json: { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: `You wrote: ${m}` }, finish_reason: 'stop' }], usage: null } };
};

async function start(p: Provider, over: Partial<GatewayConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noai-gateway-'));
  dirs.push(root);
  const vault = await createVault(root, 'a passphrase used only by this test');
  const cfg: GatewayConfig = { root, baseUrl: 'https://provider.test/v1', apiKey: 'upstream-key', model: 'default-model', maxPayloadBytes: 200_000, timeoutMs: 5000, ...over };
  const server = createGatewayServer({ vault, cfg, tokens: parseTokens(`amal:${TOKEN_A},omar:${TOKEN_B}`), transport: p.transport, models: ['other-model'] });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const call = (path: string, init: { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(base + path, {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN_A}` }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { root, vault, call, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const chat = (content: string, extra: Record<string, unknown> = {}) => ({ model: 'some-model', messages: [{ role: 'user', content }], ...extra });

describe('the gateway hides private data before forwarding', () => {
  it('sends no email, phone or ID, forwards a receipt that matches, and gives the answer back whole', async () => {
    const p = provider(echo);
    const g = await start(p);
    const text = 'Draft a reply to sami@example.com, mobile 0551234567, ID 1012345678.';
    const res = await g.call('/v1/chat/completions', { body: chat(text) });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { choices: { message: { content: string } }[]; noai: { receiptId: string; payloadHash: string } };

    assert.equal(p.sent.length, 1);
    for (const secret of ['sami@example.com', '0551234567', '1012345678']) assert.ok(!p.sent[0]!.includes(secret), `${secret} left the machine`);
    assert.match(p.sent[0]!, /\[EMAIL_1\]/);
    assert.equal(out.choices[0]!.message.content, `You wrote: ${text}`, 'the real values come back to the staff member');

    const receipts = await readReceipts(g.root);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.receipt.payloadHash, sha256(p.sent[0]!), 'the receipt hash is of the bytes that left');
    assert.equal(out.noai.payloadHash, receipts[0]!.receipt.payloadHash);
    assert.equal(receipts[0]!.receipt.client, 'amal');
    assert.deepEqual(receipts[0]!.receipt.sources, []);
    assert.ok(receipts[0]!.receipt.redactions.EMAIL === 1);
    assert.equal(verifyLedger(await readLedger(g.root), receipts).valid, true);
    assert.equal(readDisclosure(g.vault, receipts[0]!.receipt.receiptId), p.sent[0], 'the redacted body can be read back by the owner');
    await g.close();
  });

  it('hides placeholders consistently across a whole conversation, assistant turns included', async () => {
    const p = provider(echo);
    const g = await start(p);
    const res = await g.call('/v1/chat/completions', {
      body: {
        model: 'm',
        messages: [
          { role: 'system', content: 'You help the finance team. Contact is sami@example.com.' },
          { role: 'user', content: [{ type: 'text', text: 'Email sami@example.com the total.' }] },
          { role: 'assistant', content: 'Sending to sami@example.com now.' },
          { role: 'user', content: 'Also cc sami@example.com.' },
        ],
      },
    });
    assert.equal(res.status, 200);
    const sent = JSON.parse(p.sent[0]!) as { messages: { role: string; content: unknown }[] };
    assert.ok(!p.sent[0]!.includes('sami@example.com'));
    assert.equal(sent.messages.length, 5, 'the placeholder note plus four messages');
    assert.equal(sent.messages[0]!.role, 'system');
    assert.ok(Array.isArray(sent.messages[2]!.content), 'array content keeps its shape');
    assert.equal((p.sent[0]!.match(/\[EMAIL_1\]/g) ?? []).length, 5, 'one address, one placeholder, in every message');
    assert.ok(!p.sent[0]!.includes('[EMAIL_2]'));
    await g.close();
  });

  it('hides a bare name the vault knows from another note', async () => {
    const p = provider(echo);
    const g = await start(p);
    await addNote(g.vault, 'Money', 'My accountant is Zorbek Tamarind.');
    const res = await g.call('/v1/chat/completions', { body: chat('Remind Zorbek to send the invoice.') });
    const out = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.ok(!p.sent[0]!.includes('Zorbek'), 'a name the vault knows left the machine');
    assert.match(out.choices[0]!.message.content, /Zorbek/, 'the staff member reads the real name back');
    await g.close();
  });

  it('forwards only settings that carry no text, and the model the client named', async () => {
    const p = provider();
    const g = await start(p);
    await g.call('/v1/chat/completions', { body: chat('hello', { temperature: 0.3, max_tokens: 50, user: 'amal@corp.example', metadata: { who: 'amal' }, logit_bias: { '1': 5 } }) });
    const sent = JSON.parse(p.sent[0]!) as Record<string, unknown>;
    assert.equal(sent.model, 'some-model');
    assert.equal(sent.temperature, 0.3);
    assert.equal(sent.max_tokens, 50);
    for (const k of ['user', 'metadata', 'logit_bias', 'stream']) assert.equal(sent[k], undefined, `${k} was forwarded`);
    await g.close();
  });
});

describe('the gateway refuses what it cannot hide, and sends nothing', () => {
  it('rejects a missing, wrong or look-alike token with 401', async () => {
    const p = provider();
    const g = await start(p);
    for (const token of [null, 'nope', `${TOKEN_A}x`, TOKEN_A.slice(0, -1)]) {
      const res = await g.call('/v1/chat/completions', { token, body: chat('hi') });
      assert.equal(res.status, 401, String(token));
    }
    assert.equal((await g.call('/v1/models', { method: 'GET', token: 'nope' })).status, 401);
    assert.equal(p.sent.length, 0);
    assert.equal((await readLedger(g.root)).length, 0);
    await g.close();
  });

  it('rejects a browser origin that is not allowed', async () => {
    const p = provider();
    const g = await start(p);
    const res = await g.call('/v1/chat/completions', { body: chat('hi'), headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(p.sent.length, 0);
    await g.close();
  });

  it('rejects tool calls, images and unknown roles with 400', async () => {
    const p = provider();
    const g = await start(p);
    const bad: unknown[] = [
      chat('hi', { tools: [{ type: 'function', function: { name: 'f' } }] }),
      { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] },
      { model: 'm', messages: [{ role: 'tool', content: 'result', tool_call_id: 'x' }] },
      { model: 'm', messages: [{ role: 'assistant', content: null, tool_calls: [] }] },
      { model: 'm', messages: [] },
      { model: 'm' },
    ];
    for (const body of bad) {
      const res = await g.call('/v1/chat/completions', { body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(p.sent.length, 0);
    await g.close();
  });

  it('refuses a body over the byte ceiling with 413 before any byte leaves', async () => {
    const p = provider();
    const g = await start(p, { maxPayloadBytes: 500 });
    const res = await g.call('/v1/chat/completions', { body: chat('word '.repeat(400)) });
    assert.equal(res.status, 413);
    assert.equal(p.sent.length, 0);
    await g.close();
  });

  it('refuses everything when no upstream key is set', async () => {
    const p = provider();
    const g = await start(p, { apiKey: '' });
    assert.equal((await g.call('/v1/chat/completions', { body: chat('hi') })).status, 503);
    assert.equal(p.sent.length, 0);
    await g.close();
  });
});

describe('streaming and models', () => {
  it('lists the default model and the configured ones, without touching the provider', async () => {
    const p = provider();
    const g = await start(p);
    const res = await g.call('/v1/models', { method: 'GET' });
    const out = (await res.json()) as { data: { id: string }[] };
    assert.deepEqual(out.data.map((m) => m.id), ['default-model', 'other-model']);
    assert.equal(p.sent.length, 0);
    await g.close();
  });
});

describe('the gateway keeps its record when things go wrong', () => {
  it('receipts a call the provider failed, returns 502, and the chain still verifies', async () => {
    const p = provider(() => ({ status: 500, json: { error: 'boom' } }));
    const g = await start(p);
    const res = await g.call('/v1/chat/completions', { body: chat('hi sami@example.com') });
    assert.equal(res.status, 502);
    const receipts = await readReceipts(g.root);
    assert.equal(receipts.length, 1, 'bytes left, so a receipt exists');
    assert.equal(receipts[0]!.receipt.outcome, 'error');
    assert.equal(verifyLedger(await readLedger(g.root), receipts).valid, true);
    await g.close();
  });

  it('receipts a call that could not reach the provider as 502', async () => {
    const g = await start({ sent: [], transport: async () => Promise.reject(new Error('offline')) });
    const res = await g.call('/v1/chat/completions', { body: chat('hi') });
    assert.equal(res.status, 502);
    assert.equal((await readReceipts(g.root))[0]!.receipt.outcome, 'error');
    await g.close();
  });

  it('keeps the chain valid when two staff call at once', async () => {
    const p = provider(echo);
    const g = await start(p);
    const calls = Array.from({ length: 8 }, (_, i) => g.call('/v1/chat/completions', { token: i % 2 ? TOKEN_B : TOKEN_A, body: chat(`Mail s${String(i)}@example.com`) }));
    for (const r of await Promise.all(calls)) assert.equal(r.status, 200);
    const receipts = await readReceipts(g.root);
    assert.equal(receipts.length, 8);
    const verdict = verifyLedger(await readLedger(g.root), receipts);
    assert.equal(verdict.valid, true, verdict.reason);
    assert.deepEqual(new Set(receipts.map((r) => r.receipt.client)), new Set(['amal', 'omar']));
    await g.close();
  });
});

describe('tokens', () => {
  it('refuses a short secret at start-up', () => {
    assert.throws(() => parseTokens('amal:short'), /shorter than 24/);
  });
});

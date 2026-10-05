/**
 * Streaming through the company gateway, and the chat page. Real HTTP server on
 * 127.0.0.1, provider replaced by a function that streams chosen pieces. No network.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sha256 } from '../src/crypto.ts';
import type { GatewayConfig, StreamTransport } from '../src/gate.ts';
import { createGatewayServer } from '../src/gateway-serve.ts';
import { readLedger, readReceipts, verifyLedger } from '../src/ledger.ts';
import { redact, rehydrate, StreamRehydrator } from '../src/redact.ts';
import { addStaff } from '../src/staff.ts';
import { createVault } from '../src/vault.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const sse = (piece: string, finish: string | null = null): string => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: piece }, finish_reason: finish }] })}\n\n`;

interface Streamer {
  transport: StreamTransport;
  sent: string[];
}

/**
 * A provider that streams `pieces`. `status` and `breakAfter` make it fail. Chunks are cut
 * at awkward places on purpose: the network does not respect event boundaries.
 */
function streamer(pieces: string[], over: { status?: number; breakAfter?: number; echo?: boolean } = {}): Streamer {
  const sent: string[] = [];
  const transport: StreamTransport = async (_u, init) => {
    sent.push(init.body);
    if (over.status) return { ok: false, status: over.status, body: null, text: async () => 'boom' };
    let list = pieces;
    if (over.echo) {
      const last = (JSON.parse(init.body) as { messages: { content: string }[] }).messages.at(-1)!.content;
      list = ['You ', 'wrote: ', last];
    }
    const wire = list.map((p) => sse(p)).join('') + sse('', 'stop') + 'data: [DONE]\n\n';
    const bytes = Buffer.from(wire);
    async function* body(): AsyncGenerator<Uint8Array> {
      const cut = over.breakAfter !== undefined ? over.breakAfter : Infinity;
      for (let i = 0; i < bytes.length; i += 7) {
        if (i >= cut) throw new Error('connection reset');
        yield bytes.subarray(i, i + 7);
      }
    }
    return { ok: true, status: 200, body: body(), text: async () => '' };
  };
  return { transport, sent };
}

async function start(s: Streamer, over: Partial<GatewayConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noai-stream-'));
  dirs.push(root);
  const vault = await createVault(root, 'a passphrase used only by this test');
  const cfg: GatewayConfig = { root, baseUrl: 'https://provider.test/v1', apiKey: 'k', model: 'default-model', maxPayloadBytes: 200_000, timeoutMs: 5000, ...over };
  const server = createGatewayServer({ vault, cfg, streamTransport: s.transport });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const { token } = await addStaff(root, 'omar');
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    fetch(`http://127.0.0.1:${String(port)}${path}`, { method: init.method ?? 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  return { root, port, call, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
const chat = (content: string) => ({ model: 'm', stream: true, messages: [{ role: 'user', content }] });

/** The pieces of text in a stream, and the events that are not text. */
function parse(body: string): { text: string; events: Record<string, unknown>[]; done: boolean } {
  const events = body.split('\n\n').filter((e) => e.startsWith('data: ') && e !== 'data: [DONE]').map((e) => JSON.parse(e.slice(6)) as Record<string, unknown>);
  const text = events.map((e) => ((e.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content ?? '')).join('');
  return { text, events, done: body.endsWith('data: [DONE]\n\n') };
}

describe('putting values back in a reply that arrives in pieces', () => {
  it('gives the same text as the whole reply, however it is cut', () => {
    const original = 'Mail sami@example.com or call 0551234567, born 12/03/1985, ID 1012345678.';
    const r = redact(original);
    const reply = `Sure: write to ${r.text} and cc [PERSON_9] and keep [ not a placeholder [EMAIL_1] end`;
    const whole = rehydrate(reply, r.map);
    for (let i = 0; i <= reply.length; i++) {
      for (const j of [i, Math.min(reply.length, i + 3)]) {
        const h = new StreamRehydrator(r.map);
        const out = h.push(reply.slice(0, i)) + h.push(reply.slice(i, j)) + h.push(reply.slice(j)) + h.flush();
        assert.equal(out, whole, `cut at ${String(i)},${String(j)}`);
      }
    }
  });

  it('never lets half a placeholder out', () => {
    const r = redact('Mail sami@example.com');
    const h = new StreamRehydrator(r.map);
    assert.equal(h.push('Write to [EMA'), 'Write to ');
    assert.equal(h.push('IL_1'), '');
    assert.equal(h.push('] now'), 'sami@example.com now');
  });

  it('releases a lone bracket at the end as plain text', () => {
    const h = new StreamRehydrator(new Map());
    assert.equal(h.push('see [EMAIL_'), 'see ');
    assert.equal(h.flush(), '[EMAIL_');
  });
});

describe('the gateway streams, with values hidden going out and put back coming in', () => {
  it('sends no private value, streams the real ones back, and receipts the exact bytes', async () => {
    const s = streamer([], { echo: true });
    const g = await start(s);
    const res = await g.call('/v1/chat/completions', { body: chat('Mail sami@example.com, call 0551234567, born 12/03/1985, has asthma.') });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const out = parse(await res.text());
    assert.ok(out.done);
    assert.equal(out.text, 'You wrote: Mail sami@example.com, call 0551234567, born 12/03/1985, has asthma.', 'the real values came back whole');
    for (const secret of ['sami@example.com', '0551234567', '12/03/1985', 'asthma']) assert.ok(!s.sent[0]!.includes(secret), `${secret} left the machine`);
    assert.equal((JSON.parse(s.sent[0]!) as { stream: boolean }).stream, true);

    const receipts = await readReceipts(g.root);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.receipt.payloadHash, sha256(s.sent[0]!));
    assert.equal(receipts[0]!.receipt.client, 'omar');
    assert.equal(verifyLedger(await readLedger(g.root), receipts).valid, true);

    const last = out.events.at(-1) as { noai: { seq: number; payloadHash: string; redactions: Record<string, number> }; choices: { finish_reason: string }[] };
    assert.equal(last.choices[0]!.finish_reason, 'stop');
    assert.equal(last.noai.payloadHash, receipts[0]!.receipt.payloadHash);
    assert.deepEqual(Object.keys(last.noai.redactions).sort(), ['DOB', 'EMAIL', 'MEDICAL', 'PHONE']);
    assert.ok(!JSON.stringify(last.noai).includes('sami@example.com'), 'a value reached the receipt note');
    await g.close();
  });

  it('puts a placeholder back even when the provider cuts it in two', async () => {
    const s = streamer(['Write to [EMA', 'IL_1', '] today.']);
    const g = await start(s);
    const out = parse(await (await g.call('/v1/chat/completions', { body: chat('Mail sami@example.com') })).text());
    assert.equal(out.text, 'Write to sami@example.com today.');
    assert.ok(!out.text.includes('[EMA'));
    await g.close();
  });

  it('answers a provider failure before the first piece with a plain 502, and receipts it', async () => {
    const g = await start(streamer([], { status: 500 }));
    const res = await g.call('/v1/chat/completions', { body: chat('hello') });
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type') ?? '', /json/);
    const receipts = await readReceipts(g.root);
    assert.equal(receipts[0]!.receipt.outcome, 'error');
    assert.equal(verifyLedger(await readLedger(g.root), receipts).valid, true);
    await g.close();
  });

  it('ends a stream that breaks part way with an error event, and receipts it', async () => {
    const g = await start(streamer(['One ', 'two ', 'three ', 'four ', 'five ', 'six ', 'seven ', 'eight '], { breakAfter: 280 }));
    const res = await g.call('/v1/chat/completions', { body: chat('hello') });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /"error":\{"message":"The reply from default-model|"error":\{"message":"The reply from m broke off/);
    assert.ok(body.endsWith('data: [DONE]\n\n'));
    const receipts = await readReceipts(g.root);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.receipt.outcome, 'error');
    assert.equal(verifyLedger(await readLedger(g.root), receipts).valid, true);
    await g.close();
  });

  it('still refuses what it cannot hide, and sends nothing, when streaming', async () => {
    const s = streamer(['x']);
    const g = await start(s);
    const res = await g.call('/v1/chat/completions', { body: { model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] } });
    assert.equal(res.status, 400);
    assert.equal(s.sent.length, 0);
    await g.close();
  });
});

describe('the chat page', () => {
  it('is served to the machine itself, and the page can use the gateway from its own address', async () => {
    const s = streamer([], { echo: true });
    const g = await start(s);
    const page = await g.call('/chat', { method: 'GET', headers: { authorization: '' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /NOAI chat/);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const own = await g.call('/v1/chat/completions', { headers: { origin: `http://127.0.0.1:${String(g.port)}` }, body: chat('hi') });
    assert.equal(own.status, 200, 'the chat page could not call its own gateway');
    await own.text();
    const foreign = await g.call('/v1/chat/completions', { headers: { origin: 'https://evil.example' }, body: chat('hi') });
    assert.equal(foreign.status, 403);
    await g.close();
  });

  it('refuses a rebinding Host, and does not let a made-up own origin through', async () => {
    const g = await start(streamer(['x']));
    const status = await new Promise<number>((ok, no) => {
      const q = request({ host: '127.0.0.1', port: g.port, path: '/chat', headers: { host: 'evil.example' } }, (r) => {
        r.resume();
        ok(r.statusCode ?? 0);
      });
      q.on('error', no);
      q.end();
    });
    assert.equal(status, 403);
    const sneaky = await new Promise<number>((ok, no) => {
      const q = request({ host: '127.0.0.1', port: g.port, path: '/v1/models', headers: { host: 'evil.example', origin: 'http://evil.example' } }, (r) => {
        r.resume();
        ok(r.statusCode ?? 0);
      });
      q.on('error', no);
      q.end();
    });
    assert.equal(sneaky, 403, 'a page on a rebound host reached the API');
    await g.close();
  });

  it('puts server text on the screen as text, never as HTML', async () => {
    const html = await readFile(new URL('../web/gateway-chat.html', import.meta.url), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
  });
});

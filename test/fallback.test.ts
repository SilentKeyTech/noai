/**
 * The company gateway's second upstream. Two fake providers run as real HTTP
 * servers on 127.0.0.1 and the gateway reaches them with its real transport,
 * so a slow answer is really slow and a 500 is really a 500. No network.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sha256 } from '../src/crypto.ts';
import { type GatewayConfig, gatewayConfigFromEnv, looksDegenerate } from '../src/gate.ts';
import { createGatewayServer } from '../src/gateway-serve.ts';
import { readLedger, readReceipts, verifyLedger } from '../src/ledger.ts';
import { addStaff } from '../src/staff.ts';
import { createVault } from '../src/vault.ts';

const dirs: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Behaviour {
  status?: number;
  /** the reply text; given the last message as sent, placeholders intact */
  reply?: (last: string) => string;
  /** before anything at all is sent back */
  delayMs?: number;
  /** streaming: headers go at once, the first word only after this */
  firstPieceDelayMs?: number;
  /** streaming: the connection is cut after this many pieces */
  breakAfter?: number;
}

/** A fake OpenAI-compatible provider. Records every body it was sent. */
async function provider(b: Behaviour) {
  const bodies: string[] = [];
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(raw);
      void (async () => {
        await sleep(b.delayMs ?? 0);
        if (res.destroyed) return;
        if (b.status && b.status !== 200) {
          res.writeHead(b.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'boom' } }));
          return;
        }
        const req2 = JSON.parse(raw) as { model: string; stream?: boolean; messages: { content: string }[] };
        const text = (b.reply ?? ((l) => `You wrote: ${l}`))(req2.messages.at(-1)!.content);
        if (!req2.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: req2.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        await sleep(b.firstPieceDelayMs ?? 0);
        const pieces = text.match(/[\s\S]{1,9}/g) ?? [];
        for (let i = 0; i < pieces.length; i++) {
          if (res.destroyed) return;
          if (b.breakAfter !== undefined && i >= b.breakAfter) {
            res.destroy();
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }] })}\n\n`);
          await sleep(2);
        }
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      })();
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${String((s.address() as AddressInfo).port)}`;
  return { url: `http://${host}/v1`, host, bodies };
}

type Provider = Awaited<ReturnType<typeof provider>>;

async function gateway(main: Provider, fallback: Provider | null, over: Partial<GatewayConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noai-fallback-'));
  dirs.push(root);
  const vault = await createVault(root, 'a passphrase used only by this test');
  const cfg: GatewayConfig = {
    root,
    baseUrl: main.url,
    apiKey: 'main-key',
    model: 'main-model',
    maxPayloadBytes: 200_000,
    timeoutMs: 5000,
    ...(fallback ? { fallback: { baseUrl: fallback.url, apiKey: 'backup-key', model: 'backup-model' }, fallbackAfterMs: 400 } : {}),
    ...over,
  };
  const server = createGatewayServer({ vault, cfg });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const { token } = await addStaff(root, 'omar');
  const { token: adminToken } = await addStaff(root, 'boss', 'admin', 'a long enough admin password');
  const call = (body: unknown, auth = token) =>
    fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  const summary = async () =>
    (await (await fetch(`http://127.0.0.1:${String(port)}/admin/api/summary`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as { entries: { model: string; endpoint: string; outcome: string | null; fellBack: boolean }[] };
  return { root, call, summary };
}

const SECRET = 'Write to amal.haddad@example.com about the rent';
const ask = (stream = false) => ({ model: 'main-model', ...(stream ? { stream: true } : {}), messages: [{ role: 'user', content: SECRET }] });

function events(body: string) {
  const list = body.split('\n\n').filter((e) => e.startsWith('data: ') && e !== 'data: [DONE]').map((e) => JSON.parse(e.slice(6)) as { model?: string; error?: { message: string }; noai?: { model: string; fellBack?: boolean; seq: number }; choices?: { delta?: { content?: string } }[] });
  return { list, text: list.map((e) => e.choices?.[0]?.delta?.content ?? '').join(''), last: list.at(-1) };
}

/** The receipts, oldest first, and whether the chain still holds. */
async function receipts(root: string) {
  const r = await readReceipts(root);
  return { list: r.map((x) => x.receipt as typeof x.receipt & { model: string; endpoint: string; outcome?: string; fellBack?: true; payloadHash: string }), valid: verifyLedger(await readLedger(root), r).valid };
}

/** The fallback was sent the very same redacted messages as the main upstream, under its own model name. */
function sameMessages(main: Provider, fb: Provider) {
  const a = JSON.parse(main.bodies[0]!) as { model: string; messages: unknown };
  const b = JSON.parse(fb.bodies[0]!) as { model: string; messages: unknown };
  assert.deepEqual(b.messages, a.messages);
  assert.equal(b.model, 'backup-model');
  for (const body of [main.bodies[0]!, fb.bodies[0]!]) assert.ok(!body.includes('amal.haddad@example.com'), 'an email address left the machine');
}

describe('gateway fallback upstream', () => {
  it('answers from the fallback when the main upstream returns 500, and the receipt names the fallback', async () => {
    const main = await provider({ status: 500 });
    const fb = await provider({});
    const g = await gateway(main, fb);
    const r = await g.call(ask());
    assert.equal(r.status, 200);
    const j = (await r.json()) as { choices: { message: { content: string } }[]; noai: { model: string; fellBack?: boolean; payloadHash: string } };
    assert.equal(j.choices[0]!.message.content, `You wrote: ${SECRET}`, 'the real value was not put back');
    assert.equal(j.noai.model, 'backup-model');
    assert.equal(j.noai.fellBack, true);
    sameMessages(main, fb);
    const { list, valid } = await receipts(g.root);
    assert.ok(valid);
    assert.equal(list.length, 2);
    assert.deepEqual([list[0]!.model, list[0]!.endpoint, list[0]!.outcome, list[0]!.fellBack], ['main-model', main.host, 'error', undefined]);
    assert.deepEqual([list[1]!.model, list[1]!.endpoint, list[1]!.outcome, list[1]!.fellBack], ['backup-model', fb.host, undefined, true]);
    assert.equal(list[1]!.payloadHash, sha256(fb.bodies[0]!), 'the receipt does not hash what the fallback was sent');
    assert.equal(j.noai.payloadHash, list[1]!.payloadHash);
    const s = await g.summary();
    assert.deepEqual(s.entries.map((e) => [e.model, e.fellBack]), [['backup-model', true], ['main-model', false]]);
  });

  it('streams from the fallback when the main upstream sends no word before the deadline', async () => {
    const main = await provider({ firstPieceDelayMs: 3000 });
    const fb = await provider({});
    const g = await gateway(main, fb);
    const started = Date.now();
    const r = await g.call(ask(true));
    const e = events(await r.text());
    assert.ok(Date.now() - started < 2500, 'it waited for the slow upstream');
    assert.equal(e.text, `You wrote: ${SECRET}`);
    assert.ok(e.list.every((x) => x.model === 'backup-model'), 'an event named the model that did not answer');
    assert.equal(e.last!.noai!.model, 'backup-model');
    assert.equal(e.last!.noai!.fellBack, true);
    sameMessages(main, fb);
    const { list, valid } = await receipts(g.root);
    assert.ok(valid);
    assert.deepEqual(list.map((x) => [x.model, x.outcome ?? 'answered', x.fellBack ?? false]), [['main-model', 'timeout', false], ['backup-model', 'answered', true]]);
  });

  it('answers from the fallback when the main upstream is too slow to answer at all', async () => {
    const main = await provider({ delayMs: 3000 });
    const fb = await provider({});
    const g = await gateway(main, fb);
    const j = (await (await g.call(ask())).json()) as { noai: { model: string } };
    assert.equal(j.noai.model, 'backup-model');
    const { list } = await receipts(g.root);
    assert.equal(list[0]!.outcome, 'timeout');
  });

  it('throws away a reply that is clearly garbage and asks the fallback, without passing any of it on', async () => {
    const garbage = '/'.repeat(400);
    const main = await provider({ reply: () => garbage });
    const fb = await provider({});
    const g = await gateway(main, fb);
    const j = (await (await g.call(ask())).json()) as { choices: { message: { content: string } }[]; noai: { model: string } };
    assert.equal(j.choices[0]!.message.content, `You wrote: ${SECRET}`);
    assert.equal(j.noai.model, 'backup-model');

    const main2 = await provider({ reply: () => 'own '.repeat(100) });
    const fb2 = await provider({});
    const g2 = await gateway(main2, fb2);
    const e = events(await (await g2.call(ask(true))).text());
    assert.equal(e.text, `You wrote: ${SECRET}`, 'garbage reached the client');
    assert.equal(e.last!.noai!.model, 'backup-model');
    const { list, valid } = await receipts(g2.root);
    assert.ok(valid);
    assert.deepEqual(list.map((x) => [x.model, x.outcome ?? 'answered']), [['main-model', 'error'], ['backup-model', 'answered']]);
  });

  it('uses the main upstream alone when it answers well, even a long streamed answer', async () => {
    const long = 'The rent is due on the first of each month. '.repeat(12);
    const main = await provider({ reply: (l) => `${long}${l}` });
    const fb = await provider({});
    const g = await gateway(main, fb);
    const e = events(await (await g.call(ask(true))).text());
    assert.equal(e.text, `${long}${SECRET}`);
    assert.equal(e.last!.noai!.model, 'main-model');
    assert.equal(e.last!.noai!.fellBack, undefined);
    const j = (await (await g.call(ask())).json()) as { noai: { model: string; fellBack?: boolean } };
    assert.deepEqual([j.noai.model, j.noai.fellBack], ['main-model', undefined]);
    assert.equal(fb.bodies.length, 0, 'the fallback was called for no reason');
  });

  it('never switches once words have reached the client: a stream that breaks part way ends with an error', async () => {
    const main = await provider({ reply: () => 'A proper answer that goes on for a while. '.repeat(20), breakAfter: 40 });
    const fb = await provider({});
    const g = await gateway(main, fb);
    const e = events(await (await g.call(ask(true))).text());
    assert.ok(e.text.startsWith('A proper answer'));
    assert.ok(e.last!.error, 'the stream did not end with an error');
    assert.equal(fb.bodies.length, 0, 'the fallback was mixed into an answer already under way');
  });

  it('does not try the fallback for a request the provider refused as malformed', async () => {
    const main = await provider({ status: 400 });
    const fb = await provider({});
    const g = await gateway(main, fb);
    assert.equal((await g.call(ask())).status, 502);
    assert.equal(fb.bodies.length, 0);
  });

  it('says both failed when the fallback fails too, and receipts both', async () => {
    const main = await provider({ status: 503 });
    const fb = await provider({ status: 500 });
    const g = await gateway(main, fb);
    const r = await g.call(ask());
    assert.equal(r.status, 502);
    const msg = ((await r.json()) as { error: { message: string } }).error.message;
    assert.match(msg, /returned 503.*fallback was tried and also failed.*returned 500/s);
    const { list, valid } = await receipts(g.root);
    assert.ok(valid);
    assert.deepEqual(list.map((x) => [x.model, x.outcome, x.fellBack ?? false]), [['main-model', 'error', false], ['backup-model', 'error', true]]);
  });

  it('behaves exactly as before when no fallback is set', async () => {
    const failing = await provider({ status: 500 });
    const g = await gateway(failing, null);
    assert.equal((await g.call(ask())).status, 502);
    assert.equal((await g.call(ask(true))).status, 502);

    // No garbage check and no first-word deadline without somewhere else to go.
    const garbage = '/'.repeat(300);
    const g2 = await gateway(await provider({ reply: () => garbage }), null);
    const j = (await (await g2.call(ask())).json()) as { choices: { message: { content: string } }[]; noai: { model: string; fellBack?: boolean } };
    assert.equal(j.choices[0]!.message.content, garbage);
    assert.deepEqual([j.noai.model, j.noai.fellBack], ['main-model', undefined]);

    const g3 = await gateway(await provider({ firstPieceDelayMs: 700 }), null, { fallbackAfterMs: 100 });
    const e = events(await (await g3.call(ask(true))).text());
    assert.equal(e.text, `You wrote: ${SECRET}`);
    const { list } = await receipts(g3.root);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.fellBack, undefined);
  });
});

describe('garbage check', () => {
  it('catches runs of one symbol and one repeated word', () => {
    for (const t of ['/'.repeat(200), '/ / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / /', 'own own own own own own own own own own own own own own', '<unk><unk><unk><unk><unk><unk><unk><unk><unk>', `${'/'.repeat(190)} hello`]) {
      assert.equal(looksDegenerate(t), true, t);
    }
  });
  it('leaves real answers alone, short ones, tables, code and Arabic included', () => {
    for (const t of [
      'Yes.',
      '////',
      'The rent is 4,500 SAR, due on the first of each month. [PERSON_1] signed the lease on 3 March.',
      '| Item | Amount |\n|---|---|\n| Rent | 4,500 |\n| Deposit | 1,000 |',
      '```js\nconst x = [1, 2, 3].map((n) => n * 2);\nconsole.log(x);\n```',
      'الإيجار مستحق في أول كل شهر، والمبلغ أربعة آلاف وخمسمئة ريال.',
      '================\nSummary\n================\nThe contract ends on 21 October and the notice period is thirty days.',
      '1. First step\n2. Second step\n3. Third step\n4. Fourth step',
    ]) {
      assert.equal(looksDegenerate(t), false, t);
    }
  });
});

describe('fallback settings', () => {
  const keys = ['NOAI_GATEWAY_FALLBACK_UPSTREAM', 'NOAI_GATEWAY_FALLBACK_KEY', 'NOAI_GATEWAY_FALLBACK_MODEL', 'NOAI_GATEWAY_FALLBACK_AFTER_MS', 'NOAI_MODEL'] as const;
  const withEnv = (env: Partial<Record<(typeof keys)[number], string>>, fn: () => void) => {
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
  it('has no fallback unless both an upstream and a key are set', () => {
    withEnv({}, () => assert.equal(gatewayConfigFromEnv('/x').fallback, undefined));
    withEnv({ NOAI_GATEWAY_FALLBACK_UPSTREAM: 'https://b.test/v1' }, () => assert.equal(gatewayConfigFromEnv('/x').fallback, undefined));
  });
  it('reads the upstream, key, model and deadline, and signs Bedrock keys with the server role for aws-role', () => {
    withEnv({ NOAI_GATEWAY_FALLBACK_UPSTREAM: 'https://b.test/v1', NOAI_GATEWAY_FALLBACK_KEY: 'aws-role', NOAI_GATEWAY_FALLBACK_MODEL: 'openai.gpt-oss-120b-1:0', NOAI_GATEWAY_FALLBACK_AFTER_MS: '15000' }, () => {
      const c = gatewayConfigFromEnv('/x');
      assert.equal(c.fallback?.baseUrl, 'https://b.test/v1');
      assert.equal(c.fallback?.model, 'openai.gpt-oss-120b-1:0');
      assert.equal(typeof c.fallback?.keySource, 'function');
      assert.equal(c.fallbackAfterMs, 15000);
    });
    withEnv({ NOAI_GATEWAY_FALLBACK_UPSTREAM: 'https://b.test/v1', NOAI_GATEWAY_FALLBACK_KEY: 'k', NOAI_MODEL: 'same-model' }, () => {
      const c = gatewayConfigFromEnv('/x');
      assert.equal(c.fallback?.keySource, undefined);
      assert.equal(c.fallback?.model, 'same-model');
      assert.equal(c.fallbackAfterMs, 20000);
    });
  });
});

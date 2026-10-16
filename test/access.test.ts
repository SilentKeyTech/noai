/**
 * What each person may do through the company gateway: paused, limited to
 * some models, or kept from seeing the real values. Real HTTP server on
 * 127.0.0.1, provider replaced by a recording function. No network.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { GatewayConfig, StreamTransport, Transport } from '../src/gate.ts';
import { createGatewayServer, parseTokens } from '../src/gateway-serve.ts';
import { accessOf, addStaff, authenticateToken, readStaff, setAccess } from '../src/staff.ts';
import { createVault } from '../src/vault.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PASSWORD = 'correct horse battery staple';
const ENV_TOKEN = 'envy-secret-0123456789abcdef';
const lastUser = (body: string): string => (JSON.parse(body) as { messages: { content: string }[] }).messages.at(-1)?.content ?? '';

async function start() {
  const root = await mkdtemp(join(tmpdir(), 'noai-access-'));
  dirs.push(root);
  const vault = await createVault(root, 'a passphrase used only by this test');
  const sent: string[] = [];
  // Echo the user's message, so a placeholder sent is a placeholder answered.
  const transport: Transport = async (_u, init) => {
    sent.push(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: `You wrote: ${lastUser(init.body)}` }, finish_reason: 'stop' }], usage: null }) };
  };
  const streamTransport: StreamTransport = async (_u, init) => {
    sent.push(init.body);
    const wire = ['You wrote: ', lastUser(init.body)].map((p) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    async function* body(): AsyncGenerator<Uint8Array> {
      const b = Buffer.from(wire);
      for (let i = 0; i < b.length; i += 7) yield b.subarray(i, i + 7);
    }
    return { ok: true, status: 200, body: body(), text: async () => '' };
  };
  const cfg: GatewayConfig = { root, baseUrl: 'https://provider.test/v1', apiKey: 'k', model: 'default-model', maxPayloadBytes: 200_000, timeoutMs: 5000 };
  const server = createGatewayServer({ vault, cfg, transport, streamTransport, tokens: parseTokens(`envy:${ENV_TOKEN}`), models: ['small-model', 'big-model'] });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    fetch(base + path, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const ask = (token: string, content: string, extra: Record<string, unknown> = {}) => call('/v1/chat/completions', { method: 'POST', headers: as(token), body: { model: 'small-model', messages: [{ role: 'user', content }], ...extra } });
  return { root, sent, call, as, ask, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const answer = async (r: Response): Promise<string> => ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content;

describe('access in staff.json', () => {
  it('gives everything to someone with no access record, as before', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    assert.deepEqual((await authenticateToken(g.root, `Bearer ${token}`))?.access, { paused: false, models: null, showReal: true });
    assert.deepEqual(accessOf(undefined), { paused: false, models: null, showReal: true });
    await g.close();
  });

  it('changes only the fields given, lifts a model limit with null, and refuses a bad model id', async () => {
    const g = await start();
    await addStaff(g.root, 'omar');
    await setAccess(g.root, 'omar', { paused: true, models: ['small-model', ' small-model ', ''] });
    await setAccess(g.root, 'omar', { showReal: false });
    assert.deepEqual(accessOf((await readStaff(g.root))[0]), { paused: true, models: ['small-model'], showReal: false });
    await setAccess(g.root, 'omar', { models: null, paused: false });
    assert.deepEqual(accessOf((await readStaff(g.root))[0]), { paused: false, models: null, showReal: false });
    await assert.rejects(setAccess(g.root, 'omar', { models: ['bad model'] }), /not a model id/);
    assert.equal(await setAccess(g.root, 'nobody', { paused: true }), null);
    await g.close();
  });
});

describe('the gateway enforces access on every call', () => {
  it('refuses a paused person with 403 and sends nothing, then lets them back in on resume', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    await setAccess(g.root, 'omar', { paused: true });
    const r = await g.ask(token, 'hi');
    assert.equal(r.status, 403);
    assert.match(await r.text(), /paused/);
    assert.equal((await g.call('/v1/models', { headers: g.as(token) })).status, 403);
    assert.equal(g.sent.length, 0, 'a paused call reached the provider');
    await setAccess(g.root, 'omar', { paused: false });
    assert.equal((await g.ask(token, 'hi')).status, 200);
    await g.close();
  });

  it('lists only the allowed models, and refuses any other, the default included, before sending', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    await setAccess(g.root, 'omar', { models: ['small-model'] });
    const list = (await (await g.call('/v1/models', { headers: g.as(token) })).json()) as { data: { id: string }[] };
    assert.deepEqual(list.data.map((m) => m.id), ['small-model']);
    assert.equal((await g.ask(token, 'hi', { model: 'big-model' })).status, 403);
    assert.equal((await g.ask(token, 'hi', { model: undefined })).status, 403, 'the default model slipped past the limit');
    assert.equal(g.sent.length, 0);
    assert.equal((await g.ask(token, 'hi')).status, 200);
    await g.close();
  });

  it('keeps the placeholders in the answer for someone not allowed the real values, and still hides them going out', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    const { token: other } = await addStaff(g.root, 'amal');
    await setAccess(g.root, 'omar', { showReal: false });
    const text = await answer(await g.ask(token, 'Mail sami@example.com'));
    assert.match(text, /\[EMAIL_1\]/);
    assert.ok(!text.includes('sami@example.com'), 'a hidden person saw the real value');
    assert.ok(!g.sent.join('').includes('sami@example.com'));
    assert.match(await answer(await g.ask(other, 'Mail sami@example.com')), /sami@example\.com/, 'the default changed for everyone else');
    await g.close();
  });

  it('keeps the placeholders when streaming, too', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    await setAccess(g.root, 'omar', { showReal: false });
    const body = await (await g.ask(token, 'Mail sami@example.com', { stream: true })).text();
    assert.match(body, /EMAIL_1/);
    assert.ok(!body.includes('sami@example.com'));
    await g.close();
  });

  it('leaves people from NOAI_GATEWAY_TOKENS with full access', async () => {
    const g = await start();
    assert.equal((await g.ask(ENV_TOKEN, 'hi', { model: 'big-model' })).status, 200);
    await g.close();
  });
});

describe('the receipts page sets access', () => {
  const signIn = async (g: Awaited<ReturnType<typeof start>>) => {
    await addStaff(g.root, 'admin1', 'admin', PASSWORD);
    const r = await g.call('/admin/api/login', { method: 'POST', body: { name: 'admin1', password: PASSWORD } });
    return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };

  it('pauses, limits and hides from the page, and the summary shows it', async () => {
    const g = await start();
    const cookie = await signIn(g);
    const { token } = await addStaff(g.root, 'omar');
    const set = (body: unknown) => g.call('/admin/api/access', { method: 'POST', headers: { cookie }, body });
    assert.equal((await set({ name: 'omar', paused: true, models: ['small-model'], showReal: false })).status, 200);
    assert.equal((await g.ask(token, 'hi')).status, 403);
    const s = (await (await g.call('/admin/api/summary', { headers: { cookie } })).json()) as { staff: { name: string; access: unknown }[]; models: string[] };
    assert.deepEqual(s.staff.find((p) => p.name === 'omar')?.access, { paused: true, models: ['small-model'], showReal: false });
    assert.deepEqual(s.models, ['default-model', 'small-model', 'big-model']);
    await g.close();
  });

  it('refuses without signing in, refuses bad input, and never lets an admin pause themselves', async () => {
    const g = await start();
    const cookie = await signIn(g);
    await addStaff(g.root, 'omar');
    const set = (body: unknown, headers: Record<string, string> = { cookie }) => g.call('/admin/api/access', { method: 'POST', headers, body });
    assert.equal((await set({ name: 'omar', paused: true }, {})).status, 401);
    const { token } = await addStaff(g.root, 'amal');
    assert.equal((await set({ name: 'omar', paused: true }, g.as(token))).status, 401, 'a staff token changed access');
    assert.equal((await set({ name: 'admin1', paused: true })).status, 400);
    assert.equal((await set({ name: 'omar', paused: 'yes' })).status, 400);
    assert.equal((await set({ name: 'omar', models: 'small-model' })).status, 400);
    assert.equal((await set({ name: 'omar', models: ['bad model'] })).status, 400);
    assert.equal((await set({ name: 'nobody', paused: true })).status, 404);
    assert.deepEqual(accessOf((await readStaff(g.root)).find((s) => s.name === 'omar')), { paused: false, models: null, showReal: true });
    await g.close();
  });
});

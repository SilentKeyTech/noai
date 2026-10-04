/**
 * Logins and the receipts page for the company gateway. Real HTTP server on
 * 127.0.0.1, provider replaced by a recording function. No network.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { GatewayConfig, Transport } from '../src/gate.ts';
import { createGatewayServer } from '../src/gateway-serve.ts';
import { addStaff, authenticateToken, checkPassword, readStaff, revokeStaff, staffPath } from '../src/staff.ts';
import { createVault } from '../src/vault.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PASSWORD = 'correct horse battery staple';

async function start() {
  const root = await mkdtemp(join(tmpdir(), 'noai-staff-'));
  dirs.push(root);
  const vault = await createVault(root, 'a passphrase used only by this test');
  const sent: string[] = [];
  const transport: Transport = async (_u, init) => {
    sent.push(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: null }) };
  };
  const cfg: GatewayConfig = { root, baseUrl: 'https://provider.test/v1', apiKey: 'k', model: 'default-model', maxPayloadBytes: 200_000, timeoutMs: 5000 };
  const server = createGatewayServer({ vault, cfg, transport });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${String(port)}`;
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    fetch(base + path, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const login = async (name: string, password: string) => {
    const r = await call('/admin/api/login', { method: 'POST', body: { name, password } });
    return { r, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  };
  return { root, vault, sent, call, login, port, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
const chat = (content: string) => ({ model: 'm', messages: [{ role: 'user', content }] });

describe('staff store', () => {
  it('keeps no token and no password in the file, only their hashes', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'amal', 'admin', PASSWORD);
    const raw = await readFile(staffPath(g.root), 'utf8');
    assert.ok(!raw.includes(token), 'the token is in the file');
    assert.ok(!raw.includes(PASSWORD), 'the password is in the file');
    assert.ok(!raw.includes(token.slice(5, 20)));
    await g.close();
  });

  it('shows a token once, refuses a weak admin password and a duplicate name', async () => {
    const g = await start();
    await assert.rejects(addStaff(g.root, 'amal', 'admin', 'short'), /at least 12/);
    await assert.rejects(addStaff(g.root, 'bad name!', 'staff'), /letters, digits/);
    await addStaff(g.root, 'omar');
    await assert.rejects(addStaff(g.root, 'omar'), /already exists/);
    await g.close();
  });

  it('authenticates the right token and nothing close to it', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    assert.deepEqual(await authenticateToken(g.root, `Bearer ${token}`), { name: 'omar', role: 'staff' });
    for (const bad of [`Bearer ${token}x`, `Bearer ${token.slice(0, -1)}`, 'Bearer ', undefined, token]) assert.equal(await authenticateToken(g.root, bad), null);
    await g.close();
  });

  it('checks passwords, and a revoked admin cannot sign in', async () => {
    const g = await start();
    await addStaff(g.root, 'amal', 'admin', PASSWORD);
    assert.equal(await checkPassword(g.root, 'amal', PASSWORD), true);
    assert.equal(await checkPassword(g.root, 'amal', `${PASSWORD}!`), false);
    assert.equal(await checkPassword(g.root, 'nobody', PASSWORD), false);
    await revokeStaff(g.root, 'amal');
    assert.equal(await checkPassword(g.root, 'amal', PASSWORD), false);
    assert.equal((await readStaff(g.root))[0]!.revokedAt !== undefined, true);
    await g.close();
  });
});

describe('the gateway honours staff.json', () => {
  it('lets a staff token in, and a revoked one out on the very next call', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await g.call('/v1/chat/completions', { method: 'POST', headers: auth, body: chat('hi') })).status, 200);
    await revokeStaff(g.root, 'omar');
    assert.equal((await g.call('/v1/chat/completions', { method: 'POST', headers: auth, body: chat('hi') })).status, 401);
    assert.equal(g.sent.length, 1, 'the revoked call sent nothing');
    await g.close();
  });

  it('names the staff member on the receipt', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'omar');
    await g.call('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: chat('hi') });
    const { readReceipts } = await import('../src/ledger.ts');
    assert.equal((await readReceipts(g.root))[0]!.receipt.client, 'omar');
    await g.close();
  });
});

describe('the receipts page', () => {
  it('serves the page, but gives no data without signing in', async () => {
    const g = await start();
    const page = await g.call('/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal((await g.call('/admin/api/summary')).status, 401);
    assert.equal((await g.call('/admin/api/receipts/x/body')).status, 401);
    assert.equal((await g.call('/admin/api/revoke', { method: 'POST', body: { name: 'omar' } })).status, 401);
    await g.close();
  });

  it('signs an admin in, shows who sent what, and reads back only the redacted body', async () => {
    const g = await start();
    await addStaff(g.root, 'amal', 'admin', PASSWORD);
    const { token } = await addStaff(g.root, 'omar');
    await g.call('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: chat('Mail sami@example.com') });

    const { r, cookie } = await g.login('amal', PASSWORD);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(r.headers.get('set-cookie') ?? '', /SameSite=Strict/);

    const s = (await (await g.call('/admin/api/summary', { headers: { cookie } })).json()) as { verdict: { valid: boolean }; perStaff: Record<string, { calls: number; redactions: Record<string, number> }>; entries: { receiptId: string; client: string }[]; staff: { name: string }[] };
    assert.equal(s.verdict.valid, true);
    assert.equal(s.perStaff.omar!.calls, 1);
    assert.equal(s.perStaff.omar!.redactions.EMAIL, 1);
    assert.deepEqual(s.staff.map((p) => p.name).sort(), ['amal', 'omar']);
    assert.ok(!JSON.stringify(s).includes('sami@example.com'), 'a real value reached the page data');

    const body = (await (await g.call(`/admin/api/receipts/${s.entries[0]!.receiptId}/body`, { headers: { cookie } })).json()) as { body: string };
    assert.match(body.body, /\[EMAIL_1\]/);
    assert.ok(!body.body.includes('sami@example.com'), 'the page can read a real value');
    await g.close();
  });

  it('refuses a staff token, a wrong password and a made-up session', async () => {
    const g = await start();
    await addStaff(g.root, 'amal', 'admin', PASSWORD);
    const { token } = await addStaff(g.root, 'omar');
    assert.equal((await g.call('/admin/api/summary', { headers: { authorization: `Bearer ${token}` } })).status, 401, 'a staff token read the receipts');
    assert.equal((await g.login('amal', 'wrong wrong wrong')).r.status, 401);
    assert.equal((await g.login('omar', PASSWORD)).r.status, 401, 'staff signed in');
    assert.equal((await g.call('/admin/api/summary', { headers: { cookie: 'noai_session=forged' } })).status, 401);
    await g.close();
  });

  it('lets an admin token read the summary, for scripts', async () => {
    const g = await start();
    const { token } = await addStaff(g.root, 'amal', 'admin', PASSWORD);
    assert.equal((await g.call('/admin/api/summary', { headers: { authorization: `Bearer ${token}` } })).status, 200);
    await g.close();
  });

  it('locks after five wrong passwords, even for the right one', async () => {
    const g = await start();
    await addStaff(g.root, 'amal', 'admin', PASSWORD);
    for (let i = 0; i < 5; i++) assert.equal((await g.login('amal', `wrong password ${String(i)}`)).r.status, 401);
    assert.equal((await g.login('amal', PASSWORD)).r.status, 429);
    await g.close();
  });

  it('revokes someone from the page, but never yourself', async () => {
    const g = await start();
    await addStaff(g.root, 'amal', 'admin', PASSWORD);
    const { token } = await addStaff(g.root, 'omar');
    const { cookie } = await g.login('amal', PASSWORD);
    assert.equal((await g.call('/admin/api/revoke', { method: 'POST', headers: { cookie }, body: { name: 'amal' } })).status, 400);
    assert.equal((await g.call('/admin/api/revoke', { method: 'POST', headers: { cookie }, body: { name: 'omar' } })).status, 200);
    assert.equal((await g.call('/v1/models', { headers: { authorization: `Bearer ${token}` } })).status, 401);
    await g.close();
  });

  it('ends the session on sign out', async () => {
    const g = await start();
    await addStaff(g.root, 'amal', 'admin', PASSWORD);
    const { cookie } = await g.login('amal', PASSWORD);
    await g.call('/admin/api/logout', { method: 'POST', headers: { cookie } });
    assert.equal((await g.call('/admin/api/summary', { headers: { cookie } })).status, 401);
    await g.close();
  });

  it('refuses a rebinding host and a foreign origin', async () => {
    const g = await start();
    await addStaff(g.root, 'amal', 'admin', PASSWORD);
    // fetch will not let a script set Host, so speak plain HTTP to send the one a rebinding page would
    const status = await new Promise<number>((ok, no) => {
      const q = request({ host: '127.0.0.1', port: g.port, path: '/admin', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      q.on('error', no);
      q.end();
    });
    assert.equal(status, 403);
    const r = await g.call('/admin/api/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: { name: 'amal', password: PASSWORD } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('set-cookie'), null);
    await g.close();
  });

  it('the page puts server text on the screen as text, never as HTML', async () => {
    const html = await readFile(new URL('../web/gateway-admin.html', import.meta.url), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
  });
});

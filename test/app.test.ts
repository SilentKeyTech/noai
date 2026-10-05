/**
 * The NOAI app: the dashboard window's calls and the server that carries them.
 * Offline; test values only.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type AppState, handleApi } from '../src/dashboard.ts';
import { createAppServer } from '../src/mcp-serve.ts';

const VALUE = 'ghp_TESTONLYdashboard00000000000000';
const FILE = Buffer.from('TESTONLY-keystore-bytes-0001');
const dirs: string[] = [];
const closers: (() => void)[] = [];
after(async () => {
  for (const c of closers) c();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function state(): Promise<AppState> {
  const root = await mkdtemp(join(tmpdir(), 'noai-app-'));
  dirs.push(root);
  return { root, vault: null, mcpUrl: 'http://127.0.0.1:7792/mcp' };
}

describe('A1 the dashboard never shows a key', () => {
  it('A1.1 make, unlock, add text and file keys, list, connect, receipts: no response holds a value', async () => {
    const s = await state();
    const all: unknown[] = [];
    const call = async (m: string, p: string, b?: unknown) => {
      const r = await handleApi(s, m, p, b);
      all.push(r.json);
      return r;
    };
    assert.equal((await call('POST', '/create', { passphrase: 'short' })).status, 400);
    assert.equal((await call('POST', '/create', { passphrase: 'a test passphrase' })).status, 200);
    assert.equal((await call('POST', '/secrets', { name: 'github_token', sites: 'api.github.com', value: VALUE })).status, 200);
    assert.equal((await call('POST', '/secrets', { name: 'upload_keystore', sites: 'local.invalid', fileBase64: FILE.toString('base64'), fileName: 'upload.jks' })).status, 200);
    const list = await call('GET', '/secrets');
    assert.deepEqual((list.json as { keys: { name: string }[] }).keys.map((k) => k.name), ['github_token', 'upload_keystore']);
    assert.match(JSON.stringify((await call('GET', '/connect')).json), /claude mcp add/);
    assert.equal((await call('GET', '/receipts')).status, 200);
    const text = JSON.stringify(all);
    for (const form of [VALUE, Buffer.from(VALUE).toString('base64'), FILE.toString('base64'), FILE.toString('utf8')]) assert.ok(!text.includes(form));
  });

  it('A1.2 locked means locked; a wrong passphrase opens nothing', async () => {
    const s = await state();
    await handleApi(s, 'POST', '/create', { passphrase: 'a test passphrase' });
    await handleApi(s, 'POST', '/lock', {});
    assert.equal((await handleApi(s, 'GET', '/secrets', {})).status, 423);
    assert.equal((await handleApi(s, 'POST', '/unlock', { passphrase: 'wrong passphrase' })).status, 401);
    assert.equal((await handleApi(s, 'POST', '/unlock', { passphrase: 'a test passphrase' })).status, 200);
  });
});

describe('A2 the app server answers only the NOAI window on this PC', () => {
  it('A2.1 serves the window; the dashboard needs the window key and this host; agents are refused while locked', async () => {
    const s = await state();
    const server = createAppServer({ state: s, uiDir: new URL('../dashboard/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), uiToken: 'ui-test-token-0123456789', port: 0 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    // The Host check uses the port the server was told; rebuild it with the real one.
    server.close();
    const real = createAppServer({ state: s, uiDir: new URL('../dashboard/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), uiToken: 'ui-test-token-0123456789', port });
    await new Promise<void>((r) => real.listen(port, '127.0.0.1', r));
    closers.push(() => real.close());
    const base = `http://127.0.0.1:${String(port)}`;
    assert.equal((await fetch(`${base}/app/`)).status, 200);
    assert.equal((await fetch(`${base}/app/../src/vault.ts`)).status, 404);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-noai-ui': 'ui-test-token-0123456789', origin: 'http://evil.example.test' } })).status, 403);
    assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-noai-ui': 'ui-test-token-0123456789' } })).status, 200);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 503);
  });
});

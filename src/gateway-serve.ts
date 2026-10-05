/**
 * The company gateway: an OpenAI-compatible endpoint that hides private data
 * on this machine before anything is forwarded to the AI provider.
 *
 *   NOAI_PASSPHRASE=... NOAI_GATEWAY_TOKENS="amal:<secret>,omar:<secret>" npm run gateway
 *
 * Point any client that lets you set a base URL (Open WebUI, LibreChat,
 * Continue, scripts, the OpenAI SDKs) at http://127.0.0.1:7794/v1 with the
 * staff member's token as the API key. The ChatGPT and Copilot apps cannot be
 * repointed, so they cannot use this.
 *
 * Bound to 127.0.0.1 unless NOAI_GATEWAY_HOST says otherwise. This file only
 * listens; forwarding, and the only outbound call, live in gate.ts.
 *
 * Streaming is real: pieces are passed on as they arrive, with the real values
 * put back in each one. The receipt is written when the stream ends.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { forwardChat, forwardChatStream, type GatewayConfig, GatewayError, gatewayConfigFromEnv, httpStreamTransport, httpTransport, type StreamTransport, type Transport } from './gate.ts';
import { noaiHome } from './home.ts';
import { readLedger, readReceipts, verifyLedger } from './ledger.ts';
import { knownPeople } from './people.ts';
import { authenticateToken, checkPassword, readStaff, revokeStaff } from './staff.ts';
import { type OpenVault, openVault, readDisclosure, readNotes } from './vault.ts';

const MAX_BODY = 1024 * 1024;

export interface GatewayServerOptions {
  vault: OpenVault;
  cfg: GatewayConfig;
  /** staff name -> secret, from the environment. Optional: people added with `npm run staff` are read from staff.json. */
  tokens?: Map<string, string>;
  /** model ids listed at GET /v1/models; the default model is always included */
  models?: string[];
  /** Origins a browser page may call from. Requests with no Origin header are not from a page. */
  allowedOrigins?: string[];
  transport?: Transport;
  streamTransport?: StreamTransport;
}

/** "amal:secret,omar:secret" -> name to secret. Secrets must be long enough to resist guessing. */
export function parseTokens(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of raw.split(',')) {
    const i = part.indexOf(':');
    const name = part.slice(0, i).trim().replace(/[^\w.@+-]/g, '_').slice(0, 64);
    const secret = part.slice(i + 1).trim();
    if (i < 1 || !name) continue;
    if (secret.length < 24) throw new Error(`The token for "${name}" is shorter than 24 characters.`);
    out.set(name, secret);
  }
  return out;
}

/** The staff member this Authorization header belongs to, or null. Every secret is compared, in constant time. */
function who(header: string | undefined, tokens: Map<string, string>): string | null {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1] ?? '', 'utf8');
  let found: string | null = null;
  for (const [name, secret] of tokens) {
    const want = Buffer.from(secret, 'utf8');
    if (given.length === want.length && timingSafeEqual(given, want)) found = name;
  }
  return found;
}

function send(res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'cache-control': 'no-store', ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

/** OpenAI-style error body, so SDKs show the message. */
const fail = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void =>
  send(res, status, { error: { message, type: 'noai_gateway_error', code: status } }, headers);

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;

export function createGatewayServer(opts: GatewayServerOptions): Server {
  const allowedOrigins = opts.allowedOrigins ?? [];
  const transport = opts.transport ?? httpTransport;
  const streamTransport = opts.streamTransport ?? httpStreamTransport;
  const models = [...new Set([opts.cfg.model, ...(opts.models ?? [])])];
  const tokens = opts.tokens ?? new Map<string, string>();
  const root = opts.cfg.root;
  const sessions = new Map<string, { name: string; expires: number }>();
  const fails = new Map<string, number[]>();

  /** Hosts the receipts page may be reached at. Anything else is a DNS-rebinding attempt. */
  const hostOk = (req: IncomingMessage): boolean => {
    const host = req.headers.host ?? '';
    const port = String(req.socket.localPort ?? '');
    if ([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return true;
    return allowedOrigins.some((o) => new URL(o).host === host);
  };

  const adminFrom = async (req: IncomingMessage): Promise<string | null> => {
    const cookie = /(?:^|;\s*)noai_session=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const s = cookie ? sessions.get(cookie) : undefined;
    if (s && s.expires > Date.now()) return s.name;
    const t = await authenticateToken(root, req.headers.authorization);
    return t?.role === 'admin' ? t.name : null;
  };

  const admin = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    if (!hostOk(req)) return fail(res, 403, 'Host not allowed.');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return fail(res, 403, 'Origin not allowed.');
    const headers = { 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' };

    if (path === '/admin' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(await readFile(new URL('../web/gateway-admin.html', import.meta.url)));
      return;
    }
    if (path === '/admin/api/login' && req.method === 'POST') {
      const raw = await readBody(req);
      const b = raw === null ? null : (JSON.parse(raw) as { name?: unknown; password?: unknown });
      if (!b || typeof b.name !== 'string' || typeof b.password !== 'string') return fail(res, 400, 'Name and password, please.');
      const now = Date.now();
      const recent = (fails.get(b.name) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
      if (recent.length >= LOGIN_MAX_FAILS) return fail(res, 429, 'Too many wrong passwords. Wait five minutes.');
      if (!(await checkPassword(root, b.name, b.password))) {
        fails.set(b.name, [...recent, now]);
        return fail(res, 401, 'Wrong name or password.');
      }
      fails.delete(b.name);
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, { name: b.name, expires: now + SESSION_MS });
      return send(res, 200, { ok: true, name: b.name }, { 'set-cookie': `noai_session=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${String(SESSION_MS / 1000)}` });
    }
    const name = await adminFrom(req);
    if (!name) return fail(res, 401, 'Sign in first.');
    if (path === '/admin/api/logout' && req.method === 'POST') {
      const cookie = /(?:^|;\s*)noai_session=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (cookie) sessions.delete(cookie);
      return send(res, 200, { ok: true }, { 'set-cookie': 'noai_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0' });
    }
    if (path === '/admin/api/summary' && req.method === 'GET') {
      const entries = await readLedger(root);
      const receipts = await readReceipts(root);
      const byId = new Map(receipts.map((r) => [r.receipt.receiptId, r.receipt]));
      const perStaff: Record<string, { calls: number; bytes: number; failed: number; redactions: Record<string, number> }> = {};
      for (const r of receipts) {
        const k = r.receipt.client ?? '(not the gateway)';
        const s = (perStaff[k] ??= { calls: 0, bytes: 0, failed: 0, redactions: {} });
        s.calls++;
        s.bytes += r.receipt.payloadBytes;
        if (r.receipt.outcome) s.failed++;
        for (const [kind, n] of Object.entries(r.receipt.redactions)) s.redactions[kind] = (s.redactions[kind] ?? 0) + n;
      }
      return send(res, 200, {
        admin: name,
        verdict: verifyLedger(entries, receipts),
        perStaff,
        staff: (await readStaff(root)).map((s) => ({ name: s.name, role: s.role, createdAt: s.createdAt, revokedAt: s.revokedAt ?? null })),
        entries: entries.slice(-200).reverse().map((e) => {
          const r = byId.get(e.receiptId);
          return { seq: e.seq, receiptId: e.receiptId, at: e.at, model: e.model, bytes: e.payloadBytes, hash: e.payloadHash, client: r?.client ?? null, endpoint: r?.endpoint ?? null, redactions: r?.redactions ?? {}, outcome: r?.outcome ?? null };
        }),
      });
    }
    const body = /^\/admin\/api\/receipts\/([\w-]+)\/body$/.exec(path);
    if (body && req.method === 'GET') {
      const text = readDisclosure(opts.vault, body[1] ?? '');
      return text === null ? fail(res, 404, 'No sealed copy of that receipt.') : send(res, 200, { body: text });
    }
    if (path === '/admin/api/revoke' && req.method === 'POST') {
      const raw = await readBody(req);
      const b = raw === null ? null : (JSON.parse(raw) as { name?: unknown });
      if (!b || typeof b.name !== 'string') return fail(res, 400, 'Which person?');
      if (b.name === name) return fail(res, 400, 'You cannot revoke yourself.');
      return (await revokeStaff(root, b.name)) ? send(res, 200, { ok: true }) : fail(res, 404, 'No such active person.');
    }
    return fail(res, 404, 'Not found.');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/admin' || path.startsWith('/admin/')) return admin(req, res, path);
    if (path === '/chat' && req.method === 'GET') {
      if (!hostOk(req)) return fail(res, 403, 'Host not allowed.');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
      res.end(await readFile(new URL('../web/gateway-chat.html', import.meta.url)));
      return;
    }
    const origin = req.headers.origin;
    // The chat page calls this API from its own address; any other page must be listed.
    const ownOrigin = !!origin && hostOk(req) && (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`);
    if (origin && !ownOrigin && !allowedOrigins.includes(origin)) return fail(res, 403, 'Origin not allowed.');
    const client = who(req.headers.authorization, tokens) ?? (await authenticateToken(root, req.headers.authorization))?.name ?? null;
    if (!client) return fail(res, 401, 'Unauthorized.', { 'www-authenticate': 'Bearer realm="noai"' });

    if (path === '/v1/models') {
      if (req.method !== 'GET') return fail(res, 405, 'Use GET.', { allow: 'GET' });
      return send(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'noai-gateway' })) });
    }
    if (path !== '/v1/chat/completions') return fail(res, 404, 'Not found.');
    if (req.method !== 'POST') return fail(res, 405, 'Use POST.', { allow: 'POST' });

    const raw = await readBody(req);
    if (raw === null) return fail(res, 413, 'Request too large.');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail(res, 400, 'The body is not valid JSON.');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return fail(res, 400, 'The body must be a JSON object.');
    const request = json as Record<string, unknown>;

    // Names are re-read per request, so a contact added to the vault is hidden from the next call.
    const known = knownPeople(readNotes(opts.vault));
    if (request.stream === true) {
      const id = `chatcmpl-${randomBytes(9).toString('base64url')}`;
      const created = Math.floor(Date.now() / 1000);
      let model = typeof request.model === 'string' && request.model ? request.model : opts.cfg.model;
      const event = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): string =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      let begun = false;
      const begin = (): void => {
        if (begun) return;
        begun = true;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(event({ role: 'assistant', content: '' }));
      };
      try {
        const r = await forwardChatStream(opts.vault, opts.cfg, request, client, (text) => {
          begin();
          res.write(event({ content: text }));
        }, streamTransport, known);
        model = r.model;
        begin();
        res.end(`${event({}, r.finishReason ?? 'stop', { noai: { receiptId: r.signed.receipt.receiptId, seq: r.entry.seq, payloadHash: r.signed.receipt.payloadHash, redactions: r.redactions } })}data: [DONE]\n\n`);
      } catch (e) {
        // Before the first piece there is still time to answer with a plain error; after it, end the stream with one.
        if (!begun) throw e;
        const message = e instanceof Error ? e.message : String(e);
        res.end(`data: ${JSON.stringify({ error: { message, type: 'noai_gateway_error' } })}\n\ndata: [DONE]\n\n`);
      }
      return;
    }
    const r = await forwardChat(opts.vault, opts.cfg, request, client, transport, known);
    send(res, 200, r.response);
  };

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof GatewayError) return fail(res, e.status, e.message);
      fail(res, 500, e instanceof Error ? e.message : String(e));
    });
  });
}

async function main(): Promise<void> {
  const root = noaiHome();
  const tokens = parseTokens(process.env.NOAI_GATEWAY_TOKENS ?? '');
  const people = (await readStaff(root)).filter((s) => !s.revokedAt);
  if (tokens.size === 0 && people.length === 0) throw new Error('Nobody can use the gateway yet. Add someone: npm run staff -- add <name> [--admin]');
  const passphrase = process.env.NOAI_PASSPHRASE;
  if (!passphrase) throw new Error('Set NOAI_PASSPHRASE to unlock the vault.');
  const vault = await openVault(root, passphrase);
  const cfg = gatewayConfigFromEnv(root);
  const list = (name: string): string[] => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = process.env.NOAI_GATEWAY_HOST ?? '127.0.0.1';
  const port = Number(process.env.NOAI_GATEWAY_PORT ?? 7794);
  createGatewayServer({ vault, cfg, tokens, models: list('NOAI_GATEWAY_MODELS'), allowedOrigins: list('NOAI_GATEWAY_ALLOWED_ORIGINS') }).listen(port, host, () => {
    console.log(`NOAI gateway on http://${host}:${String(port)}/v1  (data in ${root})`);
    console.log(`Forwarding to ${new URL(cfg.baseUrl).host} for ${String(tokens.size + people.length)} person(s): ${[...tokens.keys(), ...people.map((p) => p.name)].join(', ')}`);
    console.log(`Receipts page: http://${host}:${String(port)}/admin${people.some((p) => p.role === 'admin') ? '' : '   (no admin yet: npm run staff -- add <name> --admin)'}`);
    if (!cfg.apiKey) console.log('Warning: no upstream key set. Every call will be refused until NOAI_GATEWAY_KEY or NEBIUS_API_KEY is set.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

/**
 * NOAI's MCP server over Streamable HTTP (MCP 2025-11-25), one endpoint: /mcp.
 *
 *   NOAI_PASSPHRASE=... NOAI_MCP_TOKEN=... npm run mcp
 *
 * Bound to 127.0.0.1 unless NOAI_MCP_HOST says otherwise. To reach it from
 * Alexa+ or any hosted assistant, put it behind an HTTPS tunnel you control;
 * the vault, the keys and the ledger never leave this machine either way.
 *
 * Three locks before any tool runs:
 *   - a bearer token (NOAI_MCP_TOKEN), compared in constant time
 *   - an Origin check, which the spec requires against DNS rebinding
 *   - a session from initialize, so every receipt names the client
 *
 * Replies are plain JSON (the spec allows it). There is no server-to-client
 * stream, so GET /mcp is 405.
 */
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { configFromEnv } from './gate.ts';
import { noaiHome } from './home.ts';
import { handleRpc, type McpContext, type McpSession, PROTOCOL_VERSIONS, scrubSecrets } from './mcp.ts';
import { newId } from './crypto.ts';
import { type OpenVault, openVault } from './vault.ts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { open as unseal } from './crypto.ts';
import { type AppState, handleApi } from './dashboard.ts';
import { reloadSecrets } from './secrets.ts';

const MAX_BODY = 64 * 1024;

export interface McpServerOptions {
  ctx: McpContext;
  token: string;
  /** Origins a browser-based client may call from. Requests with no Origin header are not from a browser page. */
  allowedOrigins: string[];
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1] ?? '', 'utf8');
  const want = Buffer.from(token, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

function send(res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'cache-control': 'no-store', ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string | null> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return null;
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function createMcpServer(opts: McpServerOptions): Server {
  const handle = mcpHandler(() => opts.ctx, () => opts.token, opts.allowedOrigins);
  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => send(res, 500, { error: scrubSecrets(opts.ctx.vault, e instanceof Error ? e.message : String(e)) }));
  });
}

/** The MCP endpoint, with its context and token read at request time so the app can lock and unlock under it. */
function mcpHandler(getCtx: () => McpContext | null, getToken: () => string | null, allowedOrigins: string[]) {
  const sessions = new Map<string, McpSession>();
  // One tool call at a time: the vault and the ledger are single-writer files.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.url ?? '').split('?')[0] !== '/mcp') return send(res, 404, { error: 'Not found.' });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: 'Origin not allowed.' });
    const ctx = getCtx();
    const token = getToken();
    if (!ctx || !token) return send(res, 503, { error: 'NOAI is locked. Open NOAI on this PC and unlock it.' });
    if (!tokenMatches(req.headers.authorization, token)) return send(res, 401, { error: 'Unauthorized.' }, { 'www-authenticate': 'Bearer realm="noai"' });

    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return send(res, 400, { error: `Unsupported MCP-Protocol-Version ${version}.` });
    }

    const sid = req.headers['mcp-session-id'];
    const sessionId = typeof sid === 'string' ? sid : null;

    if (req.method === 'DELETE') {
      if (!sessionId || !sessions.delete(sessionId)) return send(res, 404, { error: 'No such session.' });
      return send(res, 204);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' }, { allow: 'POST, DELETE' });

    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: 'Request too large.' });
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
    }

    const isInit = !!msg && typeof msg === 'object' && (msg as { method?: unknown }).method === 'initialize';
    let session: McpSession | null = null;
    if (!isInit) {
      if (!sessionId) return send(res, 400, { error: 'Missing Mcp-Session-Id. Initialize first.' });
      session = sessions.get(sessionId) ?? null;
      if (!session) return send(res, 404, { error: 'Session expired. Initialize again.' });
    }

    const reply = await serial(() => handleRpc(ctx, session, msg));
    if (!reply) return send(res, 202);

    if (isInit && 'result' in reply) {
      const params = (msg as { params?: { clientInfo?: { name?: unknown } } }).params;
      const name = typeof params?.clientInfo?.name === 'string' ? params.clientInfo.name : 'unknown';
      const id = newId();
      // The client's own name, cleaned, is what every receipt for this session will say.
      // Bounded: the oldest session is dropped once there are 64, so a client cannot grow this without limit.
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value as string);
      sessions.set(id, { client: name.replace(/[^\w.@+-]/g, '_').slice(0, 64) || 'unknown', protocolVersion: (reply.result as { protocolVersion: string }).protocolVersion });
      return send(res, 200, reply, { 'mcp-session-id': id });
    }
    send(res, 200, reply);
  };
  return handle;
}

const UI_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface AppServerOptions {
  state: AppState;
  /** the folder holding dashboard/index.html and its files */
  uiDir: string;
  /** shared with the NOAI window only, through the address it opens; every dashboard call must carry it */
  uiToken: string;
  port: number;
}

/**
 * The NOAI app: the dashboard window at /app/, its calls at /api/, and the MCP
 * endpoint for agents at /mcp, all on 127.0.0.1. /mcp answers only while the
 * vault is unlocked. The dashboard answers only this machine (Host check against
 * DNS rebinding), only the NOAI window (its token), and never with a key's value.
 */
export function createAppServer(opts: AppServerOptions): Server {
  const self = [`127.0.0.1:${String(opts.port)}`, `localhost:${String(opts.port)}`];
  const ctxFor = (): McpContext | null =>
    opts.state.vault ? { vault: opts.state.vault, cfg: configFromEnv(opts.state.root), reveal: [], toolset: 'vault' } : null;
  let token: { vault: OpenVault; value: string } | null = null;
  const mcp = mcpHandler(ctxFor, () => {
    const v = opts.state.vault;
    if (!v) return null;
    if (token?.vault !== v) {
      reloadSecrets(v);
      const aad = Buffer.from('noai.mcp-token', 'utf8');
      // The token is made by the dashboard's connect step; until then no agent can connect.
      token = v.data.mcpToken ? { vault: v, value: unseal(v.masterKey, v.data.mcpToken, aad).toString('utf8') } : null;
    }
    return token?.value ?? null;
  }, []);
  const ui = Buffer.from(opts.uiToken, 'utf8');
  let queue: Promise<unknown> = Promise.resolve();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0] as string;
    if (path === '/mcp') {
      token = null; // re-read after a lock, unlock or rotate
      return mcp(req, res);
    }
    if (!self.includes(String(req.headers.host ?? ''))) return send(res, 421, { error: 'Wrong host.' });
    if (path === '/' || path === '/app') return send(res, 302, undefined, { location: '/app/' });

    if (path.startsWith('/app/')) {
      const name = path === '/app/' ? 'index.html' : path.slice('/app/'.length);
      if (!/^[a-z0-9-]+\.(html|js|css|svg|png)$/.test(name)) return send(res, 404, { error: 'Not found.' });
      const file = join(opts.uiDir, name);
      if (!existsSync(file)) return send(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'content-type': UI_TYPES[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': UI_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      return void res.end(await readFile(file));
    }

    if (path.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && !self.some((h) => origin === `http://${h}`)) return send(res, 403, { error: 'Origin not allowed.' });
      const given = Buffer.from(String(req.headers['x-noai-ui'] ?? ''), 'utf8');
      if (given.length !== ui.length || !timingSafeEqual(given, ui)) return send(res, 401, { error: 'Open NOAI from the Start menu.' });
      let body: unknown = {};
      if (req.method === 'POST') {
        const raw = await readBody(req, 512 * 1024);
        if (raw === null) return send(res, 413, { error: 'That file is too big for a key.' });
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(res, 400, { error: 'Bad request.' });
        }
      }
      // One change at a time: the vault and the ledger are single-writer files.
      const run = queue.then(() => handleApi(opts.state, req.method ?? 'GET', path.slice('/api'.length), body));
      queue = run.catch(() => undefined);
      const r = await run;
      return send(res, r.status, r.json);
    }
    send(res, 404, { error: 'Not found.' });
  };

  return createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: 'Something went wrong. Nothing was changed.' }));
  });
}

async function main(): Promise<void> {
  const token = process.env.NOAI_MCP_TOKEN ?? '';
  if (token.length < 24) throw new Error('Set NOAI_MCP_TOKEN to a random secret of at least 24 characters.');
  const passphrase = process.env.NOAI_PASSPHRASE;
  if (!passphrase) throw new Error('Set NOAI_PASSPHRASE to unlock the vault.');
  const root = noaiHome();
  const vault = await openVault(root, passphrase);
  const reveal = (process.env.NOAI_MCP_REVEAL ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const allowedOrigins = (process.env.NOAI_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = process.env.NOAI_MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.NOAI_MCP_PORT ?? 7792);
  const toolset = (['notes', 'vault', 'all'] as const).find((t) => t === process.env.NOAI_MCP_TOOLS) ?? 'notes';
  createMcpServer({ ctx: { vault, cfg: configFromEnv(root), reveal, toolset }, token, allowedOrigins }).listen(port, host, () => {
    console.log(`NOAI MCP on http://${host}:${String(port)}/mcp  (data in ${root}, tools: ${toolset})`);
    console.log(reveal.length ? `Revealed to MCP clients: ${reveal.join(', ')}` : 'Every private value stays a placeholder for MCP clients.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

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
import { openVault } from './vault.ts';

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

export function createMcpServer(opts: McpServerOptions): Server {
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
    if (origin && !opts.allowedOrigins.includes(origin)) return send(res, 403, { error: 'Origin not allowed.' });
    if (!tokenMatches(req.headers.authorization, opts.token)) return send(res, 401, { error: 'Unauthorized.' }, { 'www-authenticate': 'Bearer realm="noai"' });

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

    const reply = await serial(() => handleRpc(opts.ctx, session, msg));
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

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => send(res, 500, { error: scrubSecrets(opts.ctx.vault, e instanceof Error ? e.message : String(e)) }));
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

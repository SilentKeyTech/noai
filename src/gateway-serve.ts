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
 * Streaming is answered, not streamed: the reply is rehydrated whole, then
 * sent as one event, so a client that asks for a stream still works.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { forwardChat, type GatewayConfig, GatewayError, gatewayConfigFromEnv, httpTransport, type Transport } from './gate.ts';
import { noaiHome } from './home.ts';
import { knownPeople } from './people.ts';
import { type OpenVault, openVault, readNotes } from './vault.ts';

const MAX_BODY = 1024 * 1024;

export interface GatewayServerOptions {
  vault: OpenVault;
  cfg: GatewayConfig;
  /** staff name -> secret */
  tokens: Map<string, string>;
  /** model ids listed at GET /v1/models; the default model is always included */
  models?: string[];
  /** Origins a browser page may call from. Requests with no Origin header are not from a page. */
  allowedOrigins?: string[];
  transport?: Transport;
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

/** The finished reply as one server-sent event, for clients that asked to stream. */
function sendAsStream(res: ServerResponse, reply: Record<string, unknown>): void {
  const choices = (Array.isArray(reply.choices) ? reply.choices : []) as { index?: number; message?: Record<string, unknown>; finish_reason?: string | null }[];
  const chunk = {
    id: reply.id,
    object: 'chat.completion.chunk',
    created: reply.created,
    model: reply.model,
    choices: choices.map((c, i) => ({ index: c.index ?? i, delta: { role: 'assistant', ...(c.message ?? {}) }, finish_reason: c.finish_reason ?? 'stop' })),
    ...(reply.usage ? { usage: reply.usage } : {}),
  };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

export function createGatewayServer(opts: GatewayServerOptions): Server {
  const allowedOrigins = opts.allowedOrigins ?? [];
  const transport = opts.transport ?? httpTransport;
  const models = [...new Set([opts.cfg.model, ...(opts.models ?? [])])];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return fail(res, 403, 'Origin not allowed.');
    const client = who(req.headers.authorization, opts.tokens);
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
    const r = await forwardChat(opts.vault, opts.cfg, request, client, transport, knownPeople(readNotes(opts.vault)));
    if (request.stream === true) return sendAsStream(res, r.response);
    send(res, 200, r.response);
  };

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof GatewayError) return fail(res, e.status, e.message);
      fail(res, 500, e instanceof Error ? e.message : String(e));
    });
  });
}

async function main(): Promise<void> {
  const tokens = parseTokens(process.env.NOAI_GATEWAY_TOKENS ?? '');
  if (tokens.size === 0) throw new Error('Set NOAI_GATEWAY_TOKENS to "name:secret,name:secret", one secret of at least 24 characters per staff member.');
  const passphrase = process.env.NOAI_PASSPHRASE;
  if (!passphrase) throw new Error('Set NOAI_PASSPHRASE to unlock the vault.');
  const root = noaiHome();
  const vault = await openVault(root, passphrase);
  const cfg = gatewayConfigFromEnv(root);
  const list = (name: string): string[] => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = process.env.NOAI_GATEWAY_HOST ?? '127.0.0.1';
  const port = Number(process.env.NOAI_GATEWAY_PORT ?? 7794);
  createGatewayServer({ vault, cfg, tokens, models: list('NOAI_GATEWAY_MODELS'), allowedOrigins: list('NOAI_GATEWAY_ALLOWED_ORIGINS') }).listen(port, host, () => {
    console.log(`NOAI gateway on http://${host}:${String(port)}/v1  (data in ${root})`);
    console.log(`Forwarding to ${new URL(cfg.baseUrl).host} for ${String(tokens.size)} staff token(s): ${[...tokens.keys()].join(', ')}`);
    if (!cfg.apiKey) console.log('Warning: no upstream key set. Every call will be refused until NOAI_GATEWAY_KEY or NEBIUS_API_KEY is set.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

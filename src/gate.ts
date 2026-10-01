/**
 * The egress gate. This is the only file in NOAI allowed to touch the network,
 * and test/gate.test.ts fails the build if any other file calls fetch.
 *
 * Every outbound call passes through here in this order:
 *   1. redact   on device, values replaced with placeholders
 *   2. budget   refuse anything larger than the configured ceiling
 *   3. hash     sha256 of the exact bytes about to leave
 *   4. send     to NVIDIA Nemotron on Nebius Token Factory
 *   5. receipt  signed with the device key, chained, sealed copy kept locally
 *   6. rehydrate placeholders back to real values, on device, for the owner
 *
 * It is also where an agent's request that names a vault secret leaves, see
 * forwardWithSecrets() at the end: the placeholder becomes the real value here
 * and nowhere else, and only on the way out.
 */
import { newId, sha256 } from './crypto.ts';
import { append } from './ledger.ts';
import { DEFAULT_MODEL, FAST_MODEL, prepareDisclosure, requestBody, stripThinking } from './prompt.ts';
import { type RedactOptions, rehydrate } from './redact.ts';

export { buildPrompt, DEFAULT_MODEL, FAST_MODEL, stripThinking } from './prompt.ts';
import type { Chunk, DisclosureReceipt, LedgerEntry, Placement, SecretUseReceipt, SignedDisclosure } from './types.ts';
import { signDisclosure, signSecretUse } from './ledger.ts';
import { type OpenVault, storeDisclosure, unwrapPrivateKey } from './vault.ts';
import { canonical, scrub } from './crypto.ts';
import { allSecretValues, findSecret, PLACEHOLDER, redactSecrets, revealSecret } from './secrets.ts';

export interface GateConfig {
  root: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** hard ceiling on the request body, in bytes */
  maxPayloadBytes: number;
  /** reasoning models spend completion tokens thinking, so this must be generous */
  maxTokens: number;
  /** tried once, with the same redacted passages, if the main model times out or fails */
  fallbackModel?: string;
  /** how long to wait for the main model before falling back, in ms */
  timeoutMs?: number;
}

export function configFromEnv(root: string): GateConfig {
  return {
    root,
    baseUrl: process.env.NEBIUS_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1',
    apiKey: process.env.NEBIUS_API_KEY ?? '',
    model: process.env.NOAI_MODEL ?? DEFAULT_MODEL,
    maxPayloadBytes: Number(process.env.NOAI_MAX_PAYLOAD ?? 8000),
    maxTokens: Number(process.env.NOAI_MAX_TOKENS ?? 4096),
    fallbackModel: process.env.NOAI_FALLBACK_MODEL ?? FAST_MODEL,
    timeoutMs: Number(process.env.NOAI_TIMEOUT_MS ?? 45000),
  };
}

export interface Transport {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export const httpTransport: Transport = (url, init) => fetch(url, init);

export interface GateResult {
  answer: string;
  /** what the model actually said, placeholders intact */
  rawAnswer: string;
  /** the exact redacted prompt that left the device */
  disclosed: string;
  signed: SignedDisclosure;
  entry: LedgerEntry;
  ms: number;
  /** the model that answered, which is the fallback if the main one did not */
  model: string;
  /** true when the main model failed and the fallback answered */
  fellBack: boolean;
  /** placeholder -> real value, never leaves this process. Lets a caller restore only some kinds. */
  restore: Map<string, string>;
}

export class GateRefused extends Error {}

/** A model call that failed after the bytes left. Worth one retry on the fallback model. */
class Unanswered extends Error {
  readonly outcome: 'timeout' | 'error';
  constructor(message: string, outcome: 'timeout' | 'error') {
    super(message);
    this.outcome = outcome;
  }
}

export async function disclose(
  v: OpenVault,
  cfg: GateConfig,
  question: string,
  chunks: Chunk[],
  transport: Transport = httpTransport,
  /** names to always hide and other names for them, found in the vault on the device */
  known: RedactOptions = {},
): Promise<GateResult> {
  const started = Date.now();
  if (!cfg.apiKey) throw new GateRefused('NEBIUS_API_KEY is not set. Nothing was sent.');

  // 1. redact, with one placeholder space across question and passages
  // A vault secret pasted into a note never reaches the model either: it goes as its placeholder.
  const secrets = allSecretValues(v);
  if (secrets.length) {
    question = redactSecrets(question, secrets).text;
    chunks = chunks.map((c) => ({ ...c, text: redactSecrets(c.text, secrets).text }));
    for (const s of secrets) scrub(s.value);
  }
  const red = prepareDisclosure(question, chunks, known);
  const disclosed = red.disclosed;
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;

  // 5. receipt, signed and chained. Every attempt that sent bytes gets one,
  // answered or not: an unanswered disclosure is still a disclosure.
  const receiptFor = async (model: string, body: string, text: string, usage: DisclosureReceipt['usage'], outcome?: 'timeout' | 'error') => {
    const receipt: DisclosureReceipt = {
      version: 1,
      kind: 'noai.disclosure',
      statement: 'This device sent exactly the payload whose hash is below, and nothing else, to the named model.',
      receiptId: newId(),
      at: new Date().toISOString(),
      endpoint: new URL(url).host,
      model,
      payloadHash: sha256(body),
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      sources: chunks.map((c) => ({ noteId: c.noteId, chunk: c.index, chunkHash: sha256(c.text) })),
      redactions: red.counts,
      responseHash: sha256(text),
      usage,
      signer: v.data.device.publicKey,
      ...(outcome ? { outcome } : {}),
    };
    const pk = unwrapPrivateKey(v);
    const signed = signDisclosure(receipt, pk);
    scrub(pk);
    const entry = await append(cfg.root, signed);
    await storeDisclosure(v, receipt.receiptId, disclosed);
    return { signed, entry };
  };

  const attempt = async (model: string) => {
    const body = requestBody(model, cfg.maxTokens, disclosed);
    // 2. budget, checked before any byte leaves
    const payloadBytes = Buffer.byteLength(body, 'utf8');
    if (payloadBytes > cfg.maxPayloadBytes) {
      throw new GateRefused(`Refused: ${String(payloadBytes)} bytes exceeds the ${String(cfg.maxPayloadBytes)} byte ceiling. Nothing was sent.`);
    }
    // 3. the hash of these exact bytes goes on the receipt. 4. send
    const controller = new AbortController();
    const timer = cfg.timeoutMs ? setTimeout(() => controller.abort(), cfg.timeoutMs) : null;
    let res: Awaited<ReturnType<Transport>>;
    let text: string;
    try {
      res = await transport(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      const timedOut = controller.signal.aborted;
      await receiptFor(model, body, '', null, timedOut ? 'timeout' : 'error');
      throw new Unanswered(timedOut ? `${model} did not answer within ${String(cfg.timeoutMs)} ms` : `${model} could not be reached: ${e instanceof Error ? e.message : String(e)}`, timedOut ? 'timeout' : 'error');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      await receiptFor(model, body, text, null, 'error');
      const msg = `Token Factory returned ${String(res.status)}: ${text.slice(0, 300)}`;
      // A request the provider refused as malformed will fail on any model, so only retry what may be transient.
      if (res.status === 429 || res.status >= 500) throw new Unanswered(msg, 'error');
      throw new Error(msg);
    }
    const json = JSON.parse(text) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const usage = json.usage ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 } : null;
    const { signed, entry } = await receiptFor(model, body, text, usage);
    const choice = json.choices?.[0];
    const rawAnswer = stripThinking(choice?.message?.content ?? '');
    // A truncated reply from a reasoning model is often raw thinking with no </think>.
    // Never show it as an answer.
    if (!rawAnswer || choice?.finish_reason === 'length') {
      const why = choice?.finish_reason === 'length' ? 'the model spent its whole token budget reasoning' : 'the model returned no visible content';
      throw new Error(`Empty answer: ${why}. The disclosure was still receipted as entry ${String(entry.seq)}.`);
    }
    return { rawAnswer, signed, entry };
  };

  let out: Awaited<ReturnType<typeof attempt>>;
  let model = cfg.model;
  let fellBack = false;
  try {
    out = await attempt(cfg.model);
  } catch (e) {
    if (!(e instanceof Unanswered) || !cfg.fallbackModel || cfg.fallbackModel === cfg.model) throw e;
    model = cfg.fallbackModel;
    fellBack = true;
    out = await attempt(cfg.fallbackModel);
  }

  // 6. rehydrate on device
  return { answer: rehydrate(out.rawAnswer, red.map), rawAnswer: out.rawAnswer, disclosed, signed: out.signed, entry: out.entry, ms: Date.now() - started, model, fellBack, restore: red.map };
}

// ---------------------------------------------------------------------------
// The agent vault. An agent writes {{secret:name}} and never holds the value.
//
//   1. policy   the host and the part of the request must be ones the owner
//               allowed for that secret, over https, or nothing is sent
//   2. inject   the real value replaces the placeholder, here, as it leaves
//   3. send     redirects are not followed, so a value cannot be carried on
//   4. scrub    every vault secret is blanked from the response the agent gets
//   5. receipt  signed and chained, sent or refused, with no secret in it
// ---------------------------------------------------------------------------

/** A request as the agent wrote it, placeholders and all. */
export interface AgentRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ForwardTransport {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual'; signal?: AbortSignal },
    maxBytes: number,
  ): Promise<{ status: number; headers: [string, string][]; body: Buffer; truncated: boolean }>;
}

export const httpForward: ForwardTransport = async (url, init, maxBytes) => {
  const res = await fetch(url, init);
  const parts: Buffer[] = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    for await (const c of res.body) {
      const b = Buffer.from(c as Uint8Array);
      if (size + b.length > maxBytes) {
        parts.push(b.subarray(0, maxBytes - size));
        truncated = true;
        break;
      }
      parts.push(b);
      size += b.length;
    }
  }
  return { status: res.status, headers: [...res.headers], body: Buffer.concat(parts), truncated };
};

export interface ForwardOptions {
  transport?: ForwardTransport;
  timeoutMs?: number;
  /** the most response body the agent is handed, in bytes */
  maxResponseBytes?: number;
}

export interface ForwardResult {
  outcome: 'sent' | 'refused' | 'error';
  status: number | null;
  /** exactly what the agent is handed, secrets blanked. Its hash is on the receipt. */
  handed: string;
  reason?: string;
  /** null only when the request named no secret, so nothing was sent and nothing is receipted */
  receipt: SecretUseReceipt | null;
  seq: number | null;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Set by the transport, never by the agent. */
const DROPPED = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection']);

export async function forwardWithSecrets(v: OpenVault, root: string, client: string, req: AgentRequest, opts: ForwardOptions = {}): Promise<ForwardResult> {
  const transport = opts.transport ?? httpForward;
  const maxBytes = opts.maxResponseBytes ?? 256 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const method = String(req.method ?? 'GET').toUpperCase();
  const rawUrl = String(req.url ?? '');
  const headersIn: Record<string, string> = {};
  for (const [k, val] of Object.entries(req.headers ?? {})) headersIn[k] = String(val);
  const body = typeof req.body === 'string' ? req.body : undefined;
  const template = canonical({ method, url: rawUrl, headers: headersIn, body: body ?? null });

  // Which secrets the request names, and where.
  const uses = new Map<string, Set<Placement>>();
  const encodings = new Map<string, Set<string>>();
  const note = (s: string, where: Placement) => {
    for (const m of s.matchAll(PLACEHOLDER)) {
      const name = m[1] as string;
      uses.set(name, (uses.get(name) ?? new Set<Placement>()).add(where));
      encodings.set(name, (encodings.get(name) ?? new Set<string>()).add(m[2] ?? 'text'));
    }
  };
  note(rawUrl, 'url');
  for (const val of Object.values(headersIn)) note(val, 'header');
  if (body !== undefined) note(body, 'body');
  for (const k of Object.keys(headersIn)) note(k, 'header');

  if (!uses.size) {
    const reason = template.includes('{{secret:')
      ? 'No usable placeholder. Write {{secret:name}} with the exact name from list_secrets. Nothing was sent.'
      : 'This tool only sends requests that use a vault secret. Nothing was sent.';
    return { outcome: 'refused', status: null, handed: `Refused: ${reason}`, reason, receipt: null, seq: null };
  }

  let host = '';
  let path = '/';
  const metas = new Map([...uses.keys()].map((n) => [n, findSecret(v, n)]));

  const receiptFor = async (outcome: SecretUseReceipt['outcome'], status: number | null, handed: string, echoes: number, reason?: string) => {
    const receipt: SecretUseReceipt = {
      version: 1,
      kind: 'noai.secret-use',
      statement:
        outcome === 'refused'
          ? 'An agent asked this device to insert the named vault secrets into a request to the host below. It was refused and nothing was sent.'
          : 'This device inserted the named vault secrets into one request to the host below, as the request left. The secret values are not in this receipt.',
      receiptId: newId(),
      at: new Date().toISOString(),
      client,
      secrets: [...uses].map(([name, where]) => ({ id: metas.get(name)?.id ?? null, name, placements: [...where].sort() })),
      method,
      host,
      path,
      requestHash: sha256(template),
      requestBytes: Buffer.byteLength(template, 'utf8'),
      outcome,
      status,
      ...(reason ? { reason } : {}),
      responseHash: sha256(handed),
      responseBytes: Buffer.byteLength(handed, 'utf8'),
      echoesRedacted: echoes,
      signer: v.data.device.publicKey,
    };
    const pk = unwrapPrivateKey(v);
    const signed = signSecretUse(receipt, pk);
    scrub(pk);
    const entry = await append(root, signed);
    return { receipt, seq: entry.seq };
  };

  const refuse = async (reason: string): Promise<ForwardResult> => {
    const handed = `Refused: ${reason} Nothing was sent.`;
    const r = await receiptFor('refused', null, handed, 0, reason);
    return { outcome: 'refused', status: null, handed, reason, ...r };
  };

  // 1. policy, before any value is unsealed
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(rawUrl)?.[1] ?? '';
  path = rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/';
  if (authority.includes('{') || authority.includes('}')) return refuse('A secret cannot go in the host name.');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return refuse('That is not a full URL.');
  }
  host = parsed.host.toLowerCase();
  if (parsed.protocol !== 'https:') return refuse('Only https requests can carry a secret.');
  if (parsed.username || parsed.password) return refuse('A URL with a user name or password in it cannot carry a secret.');
  if (!METHODS.has(method)) return refuse(`${method} is not a method this tool sends.`);
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) return refuse(`A ${method} request cannot have a body.`);
  for (const k of Object.keys(headersIn)) if (k.includes('{{')) return refuse('A secret cannot go in a header name.');
  for (const [name, where] of uses) {
    const meta = metas.get(name);
    if (!meta) return refuse(`There is no secret named ${name} in the vault.`);
    if (!meta.hosts.includes(host)) return refuse(`${name} may only be sent to ${meta.hosts.join(', ')}, not to ${host}.`);
    for (const p of where) if (!meta.placements.includes(p)) return refuse(`${name} may not go in the request ${p}. The owner allowed: ${meta.placements.join(', ')}.`);
    if (meta.kind === 'file' && encodings.get(name)?.has('text')) return refuse(`${name} is a file. Write {{secret:${name}:base64}}.`);
  }

  // 2. inject. The values live in these buffers for the length of one request and are
  // scrubbed after. Honest limit: the strings built from them cannot be scrubbed in
  // JavaScript and stay in this process's memory until the garbage collector reuses it.
  const values = new Map([...uses.keys()].map((n) => [n, revealSecret(v, n) as Buffer]));
  const inject = (s: string, inUrl = false) =>
    s.replace(PLACEHOLDER, (_m, name: string, enc?: string) => {
      const b = values.get(name) as Buffer;
      const out = enc === 'base64' ? b.toString('base64') : b.toString('utf8');
      return inUrl ? encodeURIComponent(out) : out;
    });
  const finalUrl = inject(rawUrl, true);
  const finalHeaders: Record<string, string> = {};
  for (const [k, val] of Object.entries(headersIn)) {
    if (DROPPED.has(k.toLowerCase())) continue;
    finalHeaders[k] = inject(val);
  }
  const finalBody = body === undefined ? undefined : inject(body);
  let sameHost = false;
  try {
    sameHost = new URL(finalUrl).host.toLowerCase() === host;
  } catch {
    sameHost = false;
  }
  if (!sameHost || Object.values(finalHeaders).some((h) => /[\r\n\0]/.test(h))) {
    for (const b of values.values()) scrub(b);
    return refuse('Inserting the secret would change the request in a way that is not allowed.');
  }

  // 3. send
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Awaited<ReturnType<ForwardTransport>> | null = null;
  let failure = '';
  try {
    res = await transport(finalUrl, { method, headers: finalHeaders, ...(finalBody === undefined ? {} : { body: finalBody }), redirect: 'manual', signal: controller.signal }, maxBytes);
  } catch (e) {
    failure = controller.signal.aborted ? `${host} did not answer within ${String(timeoutMs)} ms.` : `${host} could not be reached: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
    for (const b of values.values()) scrub(b);
  }

  // 4. scrub every vault secret from what goes back, error text included
  const all = allSecretValues(v);
  let echoes = 0;
  const clean = (s: string): string => {
    const r = redactSecrets(s, all);
    echoes += r.count;
    return r.text;
  };
  let handed: string;
  if (!res) {
    failure = clean(failure);
    handed = `Failed: ${failure}`;
  } else {
    // Cookies a server sets are credentials minted from the secret. The agent does not need them.
    const lines = res.headers.filter(([k]) => k.toLowerCase() !== 'set-cookie').map(([k, val]) => `${k.toLowerCase()}: ${clean(val)}`);
    const text = clean(res.body.toString('utf8'));
    handed = [`HTTP ${String(res.status)}`, ...lines, '', text, ...(res.truncated ? [`[response cut at ${String(maxBytes)} bytes]`] : [])].join('\n');
  }
  for (const s of all) scrub(s.value);

  // 5. receipt
  const r = await receiptFor(res ? 'sent' : 'error', res ? res.status : null, handed, echoes, res ? undefined : failure);
  return { outcome: res ? 'sent' : 'error', status: res ? res.status : null, handed, ...(res ? {} : { reason: failure }), ...r };
}

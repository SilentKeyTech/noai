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
 */
import { newId, sha256 } from './crypto.ts';
import { append } from './ledger.ts';
import { DEFAULT_MODEL, FAST_MODEL, prepareDisclosure, requestBody, stripThinking } from './prompt.ts';
import { type RedactOptions, redactAll, rehydrate } from './redact.ts';

export { buildPrompt, DEFAULT_MODEL, FAST_MODEL, stripThinking } from './prompt.ts';
import type { Chunk, DisclosureReceipt, LedgerEntry, SignedDisclosure } from './types.ts';
import { signDisclosure } from './ledger.ts';
import { type OpenVault, storeDisclosure, unwrapPrivateKey } from './vault.ts';
import { scrub } from './crypto.ts';

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

// ---------------------------------------------------------------------------
// Company gateway. An OpenAI-compatible chat call, redacted on this machine
// before it is forwarded. Same order as disclose(): redact, budget, hash, send,
// receipt, rehydrate. Kept apart from disclose() so branches that extend this
// file at its end do not collide with it.
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  root: string;
  /** any OpenAI-compatible base URL, Nebius Token Factory by default */
  baseUrl: string;
  apiKey: string;
  /** used only when the client names no model */
  model: string;
  /** ceiling on the forwarded body in bytes; chat history is bigger than one question */
  maxPayloadBytes: number;
  timeoutMs: number;
}

export function gatewayConfigFromEnv(root: string): GatewayConfig {
  const base = configFromEnv(root);
  return {
    root,
    baseUrl: process.env.NOAI_GATEWAY_UPSTREAM ?? base.baseUrl,
    apiKey: process.env.NOAI_GATEWAY_KEY ?? base.apiKey,
    model: base.model,
    maxPayloadBytes: Number(process.env.NOAI_GATEWAY_MAX_PAYLOAD ?? 200_000),
    timeoutMs: Number(process.env.NOAI_GATEWAY_TIMEOUT_MS ?? 120_000),
  };
}

/** A request the gateway will not forward, with the HTTP status to answer with. Nothing was sent. */
export class GatewayError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const GATEWAY_SYSTEM = 'Values like [EMAIL_1], [PHONE_1] or [PERSON_1] are placeholders for private data hidden on the company\'s own machine. Use them exactly as written, never guess what they stand for.';
const GATEWAY_ROLES = new Set(['system', 'developer', 'user', 'assistant']);
/** Settings that carry no private text. Anything else the client sends is dropped, not forwarded. */
const GATEWAY_PARAMS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'n', 'seed', 'presence_penalty', 'frequency_penalty'] as const;
/** Fields that can hold private text this gateway cannot redact. Refused, so nothing leaks past it. */
const GATEWAY_REFUSED = ['tools', 'tool_choice', 'functions', 'function_call'] as const;

export interface GatewayResult {
  /** the provider's reply with placeholders put back, ready to return to the client */
  response: Record<string, unknown>;
  /** the exact redacted body that left the machine */
  disclosed: string;
  signed: SignedDisclosure;
  entry: LedgerEntry;
  model: string;
  ms: number;
}

// The vault file and the ledger have one writer at a time.
let gatewayQueue: Promise<unknown> = Promise.resolve();
function gatewaySerial<T>(fn: () => Promise<T>): Promise<T> {
  const run = gatewayQueue.then(fn, fn);
  gatewayQueue = run.catch(() => undefined);
  return run;
}

/** Redact every message with one placeholder space and build the body that will leave. */
function gatewayBody(req: Record<string, unknown>, cfg: GatewayConfig, known: RedactOptions): { body: string; model: string; counts: Record<string, number>; map: Map<string, string> } {
  for (const k of GATEWAY_REFUSED) {
    if (req[k] !== undefined) throw new GatewayError(`"${k}" is not supported by the NOAI gateway: tool calls can carry private data it cannot hide. Nothing was sent.`, 400);
  }
  const messages = req.messages;
  if (!Array.isArray(messages) || messages.length === 0) throw new GatewayError('"messages" must be a non-empty array.', 400);

  const texts: string[] = [];
  const shapes = messages.map((m: unknown): { role: string; parts: number | null } => {
    const msg = (m ?? {}) as { role?: unknown; content?: unknown };
    if (typeof msg.role !== 'string' || !GATEWAY_ROLES.has(msg.role)) throw new GatewayError(`Message role "${String(msg.role)}" is not supported. Nothing was sent.`, 400);
    if (typeof msg.content === 'string') {
      texts.push(msg.content);
      return { role: msg.role, parts: null };
    }
    if (Array.isArray(msg.content)) {
      for (const p of msg.content as { type?: unknown; text?: unknown }[]) {
        if (p?.type !== 'text' || typeof p.text !== 'string') throw new GatewayError('Only text can be sent. Images, audio and files cannot be hidden, so they are refused. Nothing was sent.', 400);
        texts.push(p.text);
      }
      return { role: msg.role, parts: msg.content.length };
    }
    throw new GatewayError('Each message needs text "content". Nothing was sent.', 400);
  });

  const red = redactAll(texts, known);
  let at = 0;
  const out = shapes.map((s) => {
    if (s.parts === null) return { role: s.role, content: red.texts[at++] ?? '' };
    const parts = Array.from({ length: s.parts }, () => ({ type: 'text', text: red.texts[at++] ?? '' }));
    return { role: s.role, content: parts };
  });

  const model = typeof req.model === 'string' && req.model ? req.model : cfg.model;
  const params: Record<string, unknown> = {};
  for (const k of GATEWAY_PARAMS) if (req[k] !== undefined) params[k] = req[k];
  const body = JSON.stringify({ model, ...params, messages: [{ role: 'system', content: GATEWAY_SYSTEM }, ...out] });
  return { body, model, counts: red.counts, map: red.map };
}

/**
 * Forward one chat completion. `client` is the staff member the token belongs
 * to; it goes on the receipt so the log says who, never the token.
 */
export async function forwardChat(
  v: OpenVault,
  cfg: GatewayConfig,
  req: Record<string, unknown>,
  client: string,
  transport: Transport = httpTransport,
  /** names to always hide, usually knownPeople(readNotes(v)) */
  known: RedactOptions = {},
): Promise<GatewayResult> {
  const started = Date.now();
  if (!cfg.apiKey) throw new GatewayError('The gateway has no upstream key (NOAI_GATEWAY_KEY or NEBIUS_API_KEY). Nothing was sent.', 503);
  const { body, model, counts, map } = gatewayBody(req, cfg, known);
  // 2. budget, checked before any byte leaves
  const payloadBytes = Buffer.byteLength(body, 'utf8');
  if (payloadBytes > cfg.maxPayloadBytes) {
    throw new GatewayError(`Refused: ${String(payloadBytes)} bytes exceeds the ${String(cfg.maxPayloadBytes)} byte ceiling. Nothing was sent.`, 413);
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;

  // 5. receipt, signed and chained, for every attempt that sent bytes
  const receiptFor = (text: string, usage: DisclosureReceipt['usage'], outcome?: 'timeout' | 'error') =>
    gatewaySerial(async () => {
      const receipt: DisclosureReceipt = {
        version: 1,
        kind: 'noai.disclosure',
        statement: 'This device sent exactly the payload whose hash is below, and nothing else, to the named model.',
        receiptId: newId(),
        at: new Date().toISOString(),
        endpoint: new URL(url).host,
        model,
        payloadHash: sha256(body),
        payloadBytes,
        sources: [],
        redactions: counts,
        responseHash: sha256(text),
        usage,
        signer: v.data.device.publicKey,
        client,
        ...(outcome ? { outcome } : {}),
      };
      const pk = unwrapPrivateKey(v);
      const signed = signDisclosure(receipt, pk);
      scrub(pk);
      const entry = await append(cfg.root, signed);
      await storeDisclosure(v, receipt.receiptId, body);
      return { signed, entry };
    });

  // 3. the hash above is of these exact bytes. 4. send
  const controller = new AbortController();
  const timer = cfg.timeoutMs ? setTimeout(() => controller.abort(), cfg.timeoutMs) : null;
  let res: Awaited<ReturnType<Transport>>;
  let text: string;
  try {
    res = await transport(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` }, body, signal: controller.signal });
    text = await res.text();
  } catch (e) {
    const timedOut = controller.signal.aborted;
    await receiptFor('', null, timedOut ? 'timeout' : 'error');
    throw new GatewayError(timedOut ? `${model} did not answer within ${String(cfg.timeoutMs)} ms.` : `${model} could not be reached: ${e instanceof Error ? e.message : String(e)}`, timedOut ? 504 : 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    await receiptFor(text, null, 'error');
    throw new GatewayError(`The provider returned ${String(res.status)}: ${text.slice(0, 300)}`, 502);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    await receiptFor(text, null, 'error');
    throw new GatewayError('The provider returned something that is not JSON.', 502);
  }
  const u = json.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
  const { signed, entry } = await receiptFor(text, u ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 } : null);

  // 6. rehydrate on this machine
  for (const c of (Array.isArray(json.choices) ? json.choices : []) as { message?: Record<string, unknown> }[]) {
    for (const k of ['content', 'reasoning_content']) {
      const val = c.message?.[k];
      if (c.message && typeof val === 'string') c.message[k] = rehydrate(val, map);
    }
  }
  json.noai = { receiptId: signed.receipt.receiptId, seq: entry.seq, payloadHash: signed.receipt.payloadHash };
  return { response: json, disclosed: body, signed, entry, model, ms: Date.now() - started };
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

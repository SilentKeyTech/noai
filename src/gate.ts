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
import { type RedactOptions, redactAll, rehydrate, StreamRehydrator } from './redact.ts';

export { buildPrompt, DEFAULT_MODEL, FAST_MODEL, stripThinking } from './prompt.ts';
import type { Chunk, DisclosureReceipt, LedgerEntry, Placement, SecretUseReceipt, SignedDisclosure } from './types.ts';
import { signDisclosure, signSecretUse } from './ledger.ts';
import { type OpenVault, storeDisclosure, unwrapPrivateKey } from './vault.ts';
import { canonical, scrub } from './crypto.ts';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { allSecretValues, blankCutTail, findSecret, MIN_SECRET_BYTES, PLACEHOLDER, redactSecrets, reloadSecrets, revealSecret } from './secrets.ts';

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
  /**
   * Where a fresh upstream key comes from, when there is no saved one. Set by
   * NOAI_GATEWAY_KEY=aws-role: the AWS server's own role signs a short-lived
   * Bedrock key. apiKey then only says that a source is set.
   */
  keySource?: () => Promise<string>;
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
    ...(process.env.NOAI_GATEWAY_KEY === 'aws-role' ? { keySource: awsRoleKeySource(process.env.AWS_REGION ?? 'eu-north-1') } : {}),
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
function gatewayBody(req: Record<string, unknown>, cfg: GatewayConfig, known: RedactOptions, stream = false): { body: string; model: string; counts: Record<string, number>; map: Map<string, string> } {
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
  const body = JSON.stringify({ model, ...params, ...(stream ? { stream: true } : {}), messages: [{ role: 'system', content: GATEWAY_SYSTEM }, ...out] });
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
    res = await transport(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.keySource ? await cfg.keySource() : cfg.apiKey}` }, body, signal: controller.signal });
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
      if (c.message && typeof val === 'string') c.message[k] = rehydrate(k === 'content' ? dropThinking(val) : val, map);
    }
  }
  json.noai = { receiptId: signed.receipt.receiptId, seq: entry.seq, payloadHash: signed.receipt.payloadHash, redactions: counts };
  return { response: json, disclosed: body, signed, entry, model, ms: Date.now() - started };
}

/** What a streaming call needs from the network: the body as it arrives, in pieces. */
export interface StreamTransport {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array | string> | null; text(): Promise<string> }>;
}

export const httpStreamTransport: StreamTransport = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, body: r.body as unknown as AsyncIterable<Uint8Array> | null, text: () => r.text() };
};

export interface GatewayStreamResult {
  signed: SignedDisclosure;
  entry: LedgerEntry;
  model: string;
  ms: number;
  finishReason: string | null;
  /** how many values of each kind were hidden, never the values */
  redactions: Record<string, number>;
}

/**
 * Forward one chat completion and hand the reply on piece by piece, with the
 * real values put back as each piece arrives. The receipt is written when the
 * stream ends, hashing the whole reply as the provider sent it. A call that
 * fails before the first piece throws a GatewayError like forwardChat; one that
 * fails part way is receipted as an error and then throws, so the caller can
 * end its own stream with an error.
 */
export async function forwardChatStream(
  v: OpenVault,
  cfg: GatewayConfig,
  req: Record<string, unknown>,
  client: string,
  onPiece: (text: string) => void,
  transport: StreamTransport = httpStreamTransport,
  known: RedactOptions = {},
): Promise<GatewayStreamResult> {
  const started = Date.now();
  if (!cfg.apiKey) throw new GatewayError('The gateway has no upstream key (NOAI_GATEWAY_KEY or NEBIUS_API_KEY). Nothing was sent.', 503);
  const { body, model, counts, map } = gatewayBody(req, cfg, known, true);
  const payloadBytes = Buffer.byteLength(body, 'utf8');
  if (payloadBytes > cfg.maxPayloadBytes) {
    throw new GatewayError(`Refused: ${String(payloadBytes)} bytes exceeds the ${String(cfg.maxPayloadBytes)} byte ceiling. Nothing was sent.`, 413);
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const receiptFor = (raw: string, outcome?: 'timeout' | 'error') =>
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
        responseHash: sha256(raw),
        usage: null,
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

  const controller = new AbortController();
  const timer = cfg.timeoutMs ? setTimeout(() => controller.abort(), cfg.timeoutMs) : null;
  const rehydrator = new StreamRehydrator(map);
  const thinking = new ThinkingFilter();
  let raw = '';
  let finishReason: string | null = null;
  try {
    let res: Awaited<ReturnType<StreamTransport>>;
    try {
      res = await transport(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.keySource ? await cfg.keySource() : cfg.apiKey}` }, body, signal: controller.signal });
    } catch (e) {
      const timedOut = controller.signal.aborted;
      await receiptFor('', timedOut ? 'timeout' : 'error');
      throw new GatewayError(timedOut ? `${model} did not answer within ${String(cfg.timeoutMs)} ms.` : `${model} could not be reached: ${e instanceof Error ? e.message : String(e)}`, timedOut ? 504 : 502);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      await receiptFor(text, 'error');
      throw new GatewayError(`The provider returned ${String(res.status)}: ${text.slice(0, 300)}`, 502);
    }

    const decoder = new TextDecoder();
    let pending = '';
    const line = (l: string): void => {
      if (!l.startsWith('data:')) return;
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j: { choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string | null }[] };
      try {
        j = JSON.parse(data) as typeof j;
      } catch {
        return;
      }
      const c = j.choices?.[0];
      if (c?.finish_reason) finishReason = c.finish_reason;
      const piece = typeof c?.delta?.content === 'string' ? c.delta.content : '';
      if (!piece) return;
      raw += piece;
      const out = rehydrator.push(thinking.push(piece));
      if (out) onPiece(out);
    };
    try {
      for await (const chunk of res.body) {
        pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          line(pending.slice(0, nl).replace(/\r$/, ''));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf('\n');
        }
      }
      line(pending.trim());
      const rest = rehydrator.push(thinking.flush()) + rehydrator.flush();
      if (rest) onPiece(rest);
    } catch (e) {
      const timedOut = controller.signal.aborted;
      await receiptFor(raw, timedOut ? 'timeout' : 'error');
      throw new GatewayError(timedOut ? `${model} stopped answering within ${String(cfg.timeoutMs)} ms.` : `The reply from ${model} broke off: ${e instanceof Error ? e.message : String(e)}`, timedOut ? 504 : 502);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  const { signed, entry } = await receiptFor(raw);
  return { signed, entry, model, ms: Date.now() - started, finishReason, redactions: counts };
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
/** Control characters replaced, so text an agent wrote cannot move the owner's cursor or erase lines when printed. */
export const printable = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
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
  // The vault file decides, not this process's memory: a secret removed in another window is gone now.
  reloadSecrets(v);
  const metas = new Map([...uses.keys()].map((n) => [n, findSecret(v, n)]));
  // Only a known method, and no control characters, go on a receipt the owner will print.
  const recordedMethod = METHODS.has(method) ? method : 'INVALID';

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
      method: recordedMethod,
      host,
      path: printable(path).slice(0, 512),
      requestHash: sha256(template),
      requestBytes: Buffer.byteLength(template, 'utf8'),
      outcome,
      status,
      ...(reason ? { reason: printable(reason) } : {}),
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
  if (!METHODS.has(method)) return refuse(`That is not a method this tool sends. Use one of ${[...METHODS].join(', ')}.`);
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
    let text = clean(res.body.toString('utf8'));
    if (res.truncated) {
      // The cut may have fallen inside an echoed secret, leaving a start the whole-form scrub misses.
      const cut = blankCutTail(text, all);
      text = cut.text;
      echoes += cut.count;
    }
    handed = [`HTTP ${String(res.status)}`, ...lines, '', text, ...(res.truncated ? [`[response cut at ${String(maxBytes)} bytes]`] : [])].join('\n');
  }
  for (const s of all) scrub(s.value);

  // 5. receipt
  const r = await receiptFor(res ? 'sent' : 'error', res ? res.status : null, handed, echoes, res ? undefined : failure);
  return { outcome: res ? 'sent' : 'error', status: res ? res.status : null, handed, ...(res ? {} : { reason: failure }), ...r };
}

// ---------------------------------------------------------------------------
// The owner's own tools. Some secrets are not sent over HTTPS but handed to a
// program on this machine: a Gradle release build needs the upload keystore
// file and its passwords. runWithSecrets() gives them to one process, for as
// long as it runs, then takes them away:
//
//   1. env      text secrets become environment variables of that process only
//   2. file     file secrets are written to a fresh private folder, and the
//               variable holds the path. The folder is wiped when the tool exits.
//   3. scrub    the tool's output is scrubbed of every vault secret, line by line
//   4. receipt  signed and chained, like any other use, with no value in it
//
// Only the owner's command line calls this, after the passphrase. It is never
// offered to an agent over MCP: an agent that could choose the command could
// simply choose one that prints the secret.
// ---------------------------------------------------------------------------

export interface RunRequest {
  command: string;
  args: string[];
  /** environment variable -> text secret name */
  env?: Record<string, string>;
  /** environment variable -> secret name; the variable is set to the path of a temporary copy */
  files?: Record<string, string>;
  cwd?: string;
}

export interface RunOptions {
  /** where scrubbed output goes; defaults to this process's own stdout and stderr */
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** who asked, for the receipt */
  client?: string;
}

export interface RunResult {
  code: number | null;
  outcome: 'sent' | 'refused' | 'error';
  reason?: string;
  /** the folder the file secrets were written to, already wiped */
  tempDir: string | null;
  receipt: SecretUseReceipt;
  seq: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export async function runWithSecrets(v: OpenVault, root: string, req: RunRequest, opts: RunOptions = {}): Promise<RunResult> {
  const out = opts.out ?? ((t: string) => void process.stdout.write(t));
  const err = opts.err ?? ((t: string) => void process.stderr.write(t));
  const env = req.env ?? {};
  const files = req.files ?? {};
  const template = canonical({ command: req.command, args: req.args, env, files, cwd: req.cwd ?? null });
  const uses = new Map<string, Set<Placement>>();
  for (const name of Object.values(env)) uses.set(name, (uses.get(name) ?? new Set<Placement>()).add('env'));
  for (const name of Object.values(files)) uses.set(name, (uses.get(name) ?? new Set<Placement>()).add('file'));
  reloadSecrets(v);
  const metas = new Map([...uses.keys()].map((n) => [n, findSecret(v, n)]));
  const hash = createHash('sha256');
  let handedBytes = 0;
  let echoes = 0;

  const receiptFor = async (outcome: SecretUseReceipt['outcome'], status: number | null, reason?: string) => {
    const receipt: SecretUseReceipt = {
      version: 1,
      kind: 'noai.secret-use',
      statement:
        outcome === 'refused'
          ? 'The owner asked this device to hand the named vault secrets to a local program. It was refused and nothing was handed over.'
          : 'This device handed the named vault secrets to one local program for as long as it ran, then removed them. The secret values are not in this receipt.',
      receiptId: newId(),
      at: new Date().toISOString(),
      client: opts.client ?? 'owner-cli',
      secrets: [...uses].map(([name, where]) => ({ id: metas.get(name)?.id ?? null, name, placements: [...where].sort() })),
      method: 'RUN',
      host: 'local',
      path: basename(req.command),
      requestHash: sha256(template),
      requestBytes: Buffer.byteLength(template, 'utf8'),
      outcome,
      status,
      ...(reason ? { reason: printable(reason) } : {}),
      // what the owner was shown: the tool's output after scrubbing
      responseHash: hash.copy().digest('hex'),
      responseBytes: handedBytes,
      echoesRedacted: echoes,
      signer: v.data.device.publicKey,
    };
    const pk = unwrapPrivateKey(v);
    const signed = signSecretUse(receipt, pk);
    scrub(pk);
    const entry = await append(root, signed);
    return { receipt, seq: entry.seq };
  };

  const refuse = async (reason: string): Promise<RunResult> => ({ code: null, outcome: 'refused', reason, tempDir: null, ...(await receiptFor('refused', null, reason)) });

  if (!uses.size) return refuse('The command names no vault secret. Run it directly instead.');
  for (const variable of [...Object.keys(env), ...Object.keys(files)]) if (!ENV_NAME.test(variable)) return refuse(`${variable} is not a usable environment variable name.`);
  const clash = Object.keys(env).find((k) => k in files);
  if (clash) return refuse(`${clash} is given both a value and a file.`);
  for (const [name, where] of uses) {
    const meta = metas.get(name);
    if (!meta) return refuse(`There is no secret named ${name} in the vault.`);
    if (where.has('env') && meta.kind === 'file') return refuse(`${name} is a file. Give it with --file, not --env.`);
  }

  // 1 and 2. The values exist outside the vault only in this child's environment and
  // in one file inside a folder made for this run.
  // The program gets this shell's environment minus everything that opens more than it
  // was handed: the vault passphrase, the MCP token, any other NOAI or model key, and any
  // variable that happens to hold a vault secret already.
  const known = allSecretValues(v);
  const holdsSecret = (val: string) => known.some((s) => s.value.length >= MIN_SECRET_BYTES && val.includes(s.value.toString('utf8')));
  const childEnv: Record<string, string> = {};
  for (const [k, val] of Object.entries(process.env)) {
    if (val === undefined || /^(NOAI_|NEBIUS_)/i.test(k) || holdsSecret(val)) continue;
    childEnv[k] = val;
  }
  for (const s of known) scrub(s.value);
  let tempDir: string | null = null;
  const buffers: Buffer[] = [];
  const written: { path: string; bytes: number }[] = [];
  try {
    for (const [variable, name] of Object.entries(env)) {
      const b = revealSecret(v, name) as Buffer;
      buffers.push(b);
      childEnv[variable] = b.toString('utf8');
    }
    if (Object.keys(files).length) {
      tempDir = await mkdtemp(join(tmpdir(), 'noai-run-'));
      for (const [variable, name] of Object.entries(files)) {
        const b = revealSecret(v, name) as Buffer;
        buffers.push(b);
        const p = join(tempDir, `${name}${metas.get(name)?.fileName ? `-${metas.get(name)?.fileName}` : ''}`);
        await writeFile(p, b, { mode: 0o600, flag: 'wx' });
        written.push({ path: p, bytes: b.length });
        childEnv[variable] = p;
      }
    }
  } catch (e) {
    for (const b of buffers) scrub(b);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    return refuse(`The secrets could not be prepared: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. run, with output scrubbed a line at a time so a secret is never split across two writes unseen
  const all = allSecretValues(v);
  const pipe = (write: (t: string) => void) => {
    let pending = '';
    const emit = (t: string) => {
      const r = redactSecrets(t, all);
      echoes += r.count;
      hash.update(r.text);
      handedBytes += Buffer.byteLength(r.text, 'utf8');
      write(r.text);
    };
    return {
      data: (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const cut = pending.lastIndexOf('\n');
        if (cut === -1) return;
        emit(pending.slice(0, cut + 1));
        pending = pending.slice(cut + 1);
      },
      end: () => {
        if (pending) emit(pending);
        pending = '';
      },
    };
  };
  // %VAR% in an argument becomes the path of a file secret, for tools that take a path
  // rather than reading the environment. Never a text secret: arguments are visible
  // to every program on the machine that lists processes.
  const args = req.args.map((a) => a.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => (name in files ? (childEnv[name] as string) : m)));
  const o = pipe(out);
  const e2 = pipe(err);
  // Windows only runs a .bat or .cmd file, gradlew.bat for one, through the shell.
  const viaShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(req.command);
  // Through cmd.exe, a %VAR% left in the arguments would be expanded from the environment,
  // putting a password on the command line where any program can list it.
  const leaked = viaShell && args.some((a) => Object.keys(env).some((k) => a.toUpperCase().includes(`%${k.toUpperCase()}%`)));
  if (leaked) {
    for (const b of buffers) scrub(b);
    for (const w of written) await writeFile(w.path, Buffer.alloc(w.bytes)).catch(() => undefined);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    for (const s of all) scrub(s.value);
    return { ...(await refuse('A text secret may not be named as %VAR% in the arguments: it would end up on the command line. Let the program read the variable itself.')), tempDir };
  }
  let code: number | null = null;
  let failure = '';
  try {
    code = await new Promise<number | null>((done, fail) => {
      const child = spawn(viaShell ? `"${req.command}"` : req.command, args, { env: childEnv, cwd: req.cwd, shell: viaShell, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', o.data);
      child.stderr.on('data', e2.data);
      child.on('error', fail);
      child.on('close', (c) => done(c));
    });
  } catch (e) {
    failure = redactSecrets(`${req.command} could not be started: ${e instanceof Error ? e.message : String(e)}`, all).text;
  } finally {
    o.end();
    e2.end();
    // 2, undone. Overwrite before deleting: best effort, since an SSD or a backup may keep old blocks.
    for (const w of written) await writeFile(w.path, Buffer.alloc(w.bytes)).catch(() => undefined);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    for (const b of buffers) scrub(b);
    for (const s of all) scrub(s.value);
  }

  // 4. receipt
  if (failure) return { code: null, outcome: 'error', reason: failure, tempDir, ...(await receiptFor('error', null, failure)) };
  return { code, outcome: 'sent', tempDir, ...(await receiptFor('sent', code)) };
}

// ---------------------------------------------------------------------------
// A model's private notes. Some open models (gpt-oss on Bedrock) put their
// working in <reasoning>...</reasoning> or <think>...</think> before the answer.
// The person reads only the answer; the receipt keeps every byte.
// ---------------------------------------------------------------------------

export class ThinkingFilter {
  private buf = '';
  private inside: string | null = null;

  push(text: string): string {
    this.buf += text;
    let out = '';
    for (;;) {
      if (this.inside) {
        const close = `</${this.inside}>`;
        const end = this.buf.indexOf(close);
        if (end < 0) {
          // Keep only what could still be the start of the closing tag.
          this.buf = this.buf.slice(Math.max(0, this.buf.length - (close.length - 1)));
          return out;
        }
        this.buf = this.buf.slice(end + close.length).replace(/^\s+/, '');
        this.inside = null;
        continue;
      }
      const open = /<(reasoning|think)>/.exec(this.buf);
      if (open) {
        out += this.buf.slice(0, open.index);
        this.buf = this.buf.slice(open.index + open[0].length);
        this.inside = open[1]!;
        continue;
      }
      // Hold back a "<rea" that may become "<reasoning>" in the next piece.
      const lt = this.buf.lastIndexOf('<');
      if (lt >= 0 && /^<[a-z]{0,9}$/.test(this.buf.slice(lt))) {
        out += this.buf.slice(0, lt);
        this.buf = this.buf.slice(lt);
        return out;
      }
      out += this.buf;
      this.buf = '';
      return out;
    }
  }

  /** The end of the reply: anything held back was plain text, unless it was inside the notes. */
  flush(): string {
    const rest = this.inside ? '' : this.buf;
    this.buf = '';
    this.inside = null;
    return rest;
  }
}

export function dropThinking(text: string): string {
  const f = new ThinkingFilter();
  return f.push(text) + f.flush();
}

// ---------------------------------------------------------------------------
// AWS role key. On an AWS server the gateway keeps no saved key: the server's
// own role (its instance profile) signs a Bedrock API key that lasts at most
// as long as the role's credentials, and a new one is signed before that.
// Nothing is written to disk. The credentials come from the instance metadata
// service (IMDSv2), or from AWS_ACCESS_KEY_ID and friends when those are set.
// ---------------------------------------------------------------------------

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ms since epoch */
  expiration?: number;
}

const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * A Bedrock API key in the same form as AWS's own token generator: a SigV4
 * presigned CallWithBearerToken request, base64 encoded behind "bedrock-api-key-".
 */
export function bedrockApiKey(creds: AwsCredentials, region: string, now: Date = new Date(), expiresIn = 43200): string {
  const host = 'bedrock.amazonaws.com';
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/bedrock/aws4_request`;
  const q: Record<string, string> = {
    Action: 'CallWithBearerToken',
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  if (creds.sessionToken) q['X-Amz-Security-Token'] = creds.sessionToken;
  const query = Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(q[k]!)}`).join('&');
  // As AWS's own generator does it (botocore SigV4QueryAuth): a POST presigned in
  // the query, with the hash of the empty body. Checked against it on 7 Oct 2026.
  const emptyHash = createHash('sha256').update('').digest('hex');
  const canonicalRequest = ['POST', '/', query, `host:${host}`, '', 'host', emptyHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');
  let key: Buffer = createHmac('sha256', 'AWS4' + creds.secretAccessKey).update(day).digest();
  for (const part of [region, 'bedrock', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return 'bedrock-api-key-' + Buffer.from(`${host}/?${query}&X-Amz-Signature=${signature}&Version=1`, 'utf8').toString('base64');
}

const IMDS = 'http://169.254.169.254/latest';

/** A plain request to the instance metadata service; a GET carries no body. */
export type MetadataFetch = (url: string, init: { method: 'GET' | 'PUT'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const metadataFetch: MetadataFetch = (url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(2000) });

/** The role credentials of this AWS server, or the ones in the environment. */
export async function awsCredentials(get$: MetadataFetch = metadataFetch): Promise<AwsCredentials> {
  const env = process.env;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  }
  const get = async (path: string, token: string): Promise<string> => {
    const r = await get$(`${IMDS}${path}`, { method: 'GET', headers: { 'x-aws-ec2-metadata-token': token } });
    if (!r.ok) throw new GatewayError(`The server's AWS role could not be read (${String(r.status)}). Nothing was sent.`, 503);
    return r.text();
  };
  const t = await get$(`${IMDS}/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' } }).catch(() => null);
  if (!t?.ok) throw new GatewayError('This is not an AWS server with a role, so NOAI_GATEWAY_KEY=aws-role cannot work. Nothing was sent.', 503);
  const token = await t.text();
  const role = (await get('/meta-data/iam/security-credentials/', token)).split('\n')[0]?.trim() ?? '';
  if (!role) throw new GatewayError('This AWS server has no role attached. Nothing was sent.', 503);
  const c = JSON.parse(await get(`/meta-data/iam/security-credentials/${role}`, token)) as { AccessKeyId: string; SecretAccessKey: string; Token: string; Expiration: string };
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token, expiration: Date.parse(c.Expiration) };
}

/** A key source that signs a new Bedrock key when the last one is half an hour old or its credentials are about to run out. */
export function awsRoleKeySource(region: string, get$: MetadataFetch = metadataFetch, now: () => number = Date.now): () => Promise<string> {
  let cached: { key: string; renewAt: number } | null = null;
  return async () => {
    if (cached && now() < cached.renewAt) return cached.key;
    const creds = await awsCredentials(get$);
    const t = now();
    const left = creds.expiration ? Math.max(0, Math.floor((creds.expiration - t) / 1000) - 60) : 43200;
    const key = bedrockApiKey(creds, region, new Date(t), Math.min(43200, Math.max(60, left)));
    cached = { key, renewAt: Math.min(t + 30 * 60_000, creds.expiration ? creds.expiration - 5 * 60_000 : Infinity) };
    return key;
  };
}

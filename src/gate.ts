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
import { rehydrate } from './redact.ts';

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

export async function disclose(
  v: OpenVault,
  cfg: GateConfig,
  question: string,
  chunks: Chunk[],
  transport: Transport = httpTransport,
  /** names to always hide, found in the vault on the device */
  people: string[] = [],
): Promise<GateResult> {
  const started = Date.now();
  if (!cfg.apiKey) throw new GateRefused('NEBIUS_API_KEY is not set. Nothing was sent.');

  // 1. redact, with one placeholder space across question and passages
  const red = prepareDisclosure(question, chunks, people);
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

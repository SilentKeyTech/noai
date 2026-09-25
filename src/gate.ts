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
import { redactAll, rehydrate } from './redact.ts';
import type { Chunk, DisclosureReceipt, LedgerEntry, SignedDisclosure } from './types.ts';
import { signDisclosure } from './ledger.ts';
import { type OpenVault, storeDisclosure, unwrapPrivateKey } from './vault.ts';
import { scrub } from './crypto.ts';

export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const FAST_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

export interface GateConfig {
  root: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** hard ceiling on the request body, in bytes */
  maxPayloadBytes: number;
  /** reasoning models spend completion tokens thinking, so this must be generous */
  maxTokens: number;
}

export function configFromEnv(root: string): GateConfig {
  return {
    root,
    baseUrl: process.env.NEBIUS_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1',
    apiKey: process.env.NEBIUS_API_KEY ?? '',
    model: process.env.NOAI_MODEL ?? DEFAULT_MODEL,
    maxPayloadBytes: Number(process.env.NOAI_MAX_PAYLOAD ?? 8000),
    maxTokens: Number(process.env.NOAI_MAX_TOKENS ?? 4096),
  };
}

export interface Transport {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
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
}

const SYSTEM = [
  'You are NOAI, a private assistant. You only see the passages below, chosen and redacted on the owner\'s device.',
  'Answer from the passages only. If they do not contain the answer, say so plainly.',
  'Values like [EMAIL_1] or [PHONE_2] are placeholders for redacted data. Use them exactly as written, never guess what they stand for.',
  'Be brief. Cite passages as [P1], [P2].',
].join(' ');

export function buildPrompt(question: string, passages: { title: string; text: string }[]): string {
  const ctx = passages.map((p, i) => `[P${String(i + 1)}] ${p.title}\n${p.text}`).join('\n\n');
  return `PASSAGES\n${ctx || '(none matched)'}\n\nQUESTION\n${question}`;
}

/** Nemotron and other reasoning models may put their thinking inline. It is not part of the answer. */
export function stripThinking(text: string): string {
  return text.replace(/^[\s\S]*?<\/think>/, '').trim();
}

export class GateRefused extends Error {}

export async function disclose(
  v: OpenVault,
  cfg: GateConfig,
  question: string,
  chunks: Chunk[],
  transport: Transport = httpTransport,
): Promise<GateResult> {
  const started = Date.now();
  if (!cfg.apiKey) throw new GateRefused('NEBIUS_API_KEY is not set. Nothing was sent.');

  // 1. redact, with one placeholder space across question and passages
  const red = redactAll([question, ...chunks.flatMap((c) => [c.title, c.text])]);
  const [q = '', ...rest] = red.texts;
  const passages = chunks.map((_, i) => ({ title: rest[i * 2] ?? '', text: rest[i * 2 + 1] ?? '' }));
  const disclosed = buildPrompt(q, passages);

  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: disclosed },
    ],
  });

  // 2. budget
  const payloadBytes = Buffer.byteLength(body, 'utf8');
  if (payloadBytes > cfg.maxPayloadBytes) {
    throw new GateRefused(`Refused: ${String(payloadBytes)} bytes exceeds the ${String(cfg.maxPayloadBytes)} byte ceiling. Nothing was sent.`);
  }

  // 3. hash the exact bytes
  const payloadHash = sha256(body);

  // 4. send
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await transport(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token Factory returned ${String(res.status)}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as {
    choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  const content = choice?.message?.content ?? '';
  const rawAnswer = stripThinking(content);

  // 5. receipt, signed and chained, even when the answer came back empty
  const receipt: DisclosureReceipt = {
    version: 1,
    kind: 'noai.disclosure',
    statement: 'This device sent exactly the payload whose hash is below, and nothing else, to the named model.',
    receiptId: newId(),
    at: new Date().toISOString(),
    endpoint: new URL(url).host,
    model: cfg.model,
    payloadHash,
    payloadBytes,
    sources: chunks.map((c) => ({ noteId: c.noteId, chunk: c.index, chunkHash: sha256(c.text) })),
    redactions: red.counts,
    responseHash: sha256(text),
    usage: json.usage
      ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
      : null,
    signer: v.data.device.publicKey,
  };
  const pk = unwrapPrivateKey(v);
  const signed = signDisclosure(receipt, pk);
  scrub(pk);
  const entry = await append(cfg.root, signed);
  await storeDisclosure(v, receipt.receiptId, disclosed);

  // A truncated reply from a reasoning model is often raw thinking with no </think>.
  // Never show it as an answer.
  if (!rawAnswer || choice?.finish_reason === 'length') {
    const why = choice?.finish_reason === 'length' ? 'the model spent its whole token budget reasoning' : 'the model returned no visible content';
    throw new Error(`Empty answer: ${why}. The disclosure was still receipted as entry ${String(entry.seq)}.`);
  }

  // 6. rehydrate on device
  return { answer: rehydrate(rawAnswer, red.map), rawAnswer, disclosed, signed, entry, ms: Date.now() - started };
}

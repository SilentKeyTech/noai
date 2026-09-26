/**
 * The egress gate, browser edition. The only file in web/app/lib that sends
 * anything anywhere, and test/web.test.ts fails the build if another one does.
 *
 * Same six steps as src/gate.ts: redact, budget, hash, send, receipt,
 * rehydrate. The prompt and request body come from the shared core, so what
 * leaves the browser is byte for byte what the desktop would send.
 *
 * It sends to the relay on this origin, not to Nebius directly, because a
 * browser cannot hold the API key. The relay forwards the exact bytes and adds
 * the key. The receipt hash covers the bytes this page sent.
 */
import { prepareDisclosure, requestBody, stripThinking } from './core/prompt.js';
import { rehydrate } from './core/redact.js';
import { append, signDisclosure } from './ledger.js';
import { storeDisclosure, unwrapSecretKey } from './vault.js';
import { newId, scrub, sha256, utf8 } from './wcrypto.js';

export const UPSTREAM_HOST = 'api.tokenfactory.nebius.com';

export class GateRefused extends Error {}

export const httpTransport = (url, init) => fetch(url, init);

export async function disclose(v, cfg, question, chunks, transport = httpTransport) {
  const started = Date.now();

  // 1. redact, with one placeholder space across question and passages
  const red = prepareDisclosure(question, chunks);
  const body = requestBody(cfg.model, cfg.maxTokens, red.disclosed);

  // 2. budget
  const payloadBytes = utf8(body).length;
  if (payloadBytes > cfg.maxPayloadBytes) {
    throw new GateRefused(`Refused: ${payloadBytes} bytes exceeds the ${cfg.maxPayloadBytes} byte ceiling. Nothing was sent.`);
  }

  // 3. hash the exact bytes
  const payloadHash = sha256(body);

  // 4. send, through the relay
  const res = await transport(cfg.relayUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`The relay returned ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const choice = json.choices?.[0];
  const rawAnswer = stripThinking(choice?.message?.content ?? '');

  // 5. receipt, signed and chained, even when the answer came back empty
  const receipt = {
    version: 1,
    kind: 'noai.disclosure',
    statement: 'This device sent exactly the payload whose hash is below, and nothing else, to the named model.',
    receiptId: newId(),
    at: new Date().toISOString(),
    endpoint: UPSTREAM_HOST,
    model: cfg.model,
    payloadHash,
    payloadBytes,
    sources: await Promise.all(chunks.map(async (c) => ({ noteId: c.noteId, chunk: c.index, chunkHash: sha256(c.text) }))),
    redactions: red.counts,
    responseHash: sha256(text),
    usage: json.usage ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 } : null,
    signer: v.data.device.publicKey,
  };
  const sk = await unwrapSecretKey(v);
  const signed = signDisclosure(receipt, sk);
  scrub(sk);
  const entry = await append(v.store, signed);
  await storeDisclosure(v, receipt.receiptId, red.disclosed);

  if (!rawAnswer || choice?.finish_reason === 'length') {
    const why = choice?.finish_reason === 'length' ? 'the model spent its whole token budget reasoning' : 'the model returned no visible content';
    throw new Error(`Empty answer: ${why}. The disclosure was still receipted as entry ${entry.seq}.`);
  }

  // 6. rehydrate on device
  return { answer: rehydrate(rawAnswer, red.map), rawAnswer, disclosed: red.disclosed, signed, entry, ms: Date.now() - started };
}

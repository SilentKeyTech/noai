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
 *
 * If the main model times out or fails, the same redacted passages go once to
 * the fallback model. Every attempt that sent bytes gets its own receipt.
 */
import { prepareDisclosure, requestBody, stripThinking } from './core/prompt.js';
import { rehydrate } from './core/redact.js';
import { append, signDisclosure } from './ledger.js';
import { storeDisclosure, unwrapSecretKey } from './vault.js';
import { newId, scrub, sha256, utf8 } from './wcrypto.js';

export const UPSTREAM_HOST = 'api.tokenfactory.nebius.com';

export class GateRefused extends Error {}

class Unanswered extends Error {
  constructor(message, outcome) {
    super(message);
    this.outcome = outcome;
  }
}

export const httpTransport = (url, init) => fetch(url, init);

export async function disclose(v, cfg, question, chunks, transport = httpTransport) {
  const started = Date.now();

  // 1. redact, with one placeholder space across question and passages
  const red = prepareDisclosure(question, chunks);

  // 5. receipt, signed and chained, for every attempt that sent bytes
  const receiptFor = async (model, body, text, usage, outcome) => {
    const receipt = {
      version: 1,
      kind: 'noai.disclosure',
      statement: 'This device sent exactly the payload whose hash is below, and nothing else, to the named model.',
      receiptId: newId(),
      at: new Date().toISOString(),
      endpoint: UPSTREAM_HOST,
      model,
      payloadHash: sha256(body),
      payloadBytes: utf8(body).length,
      sources: chunks.map((c) => ({ noteId: c.noteId, chunk: c.index, chunkHash: sha256(c.text) })),
      redactions: red.counts,
      responseHash: sha256(text),
      usage,
      signer: v.data.device.publicKey,
      ...(outcome ? { outcome } : {}),
    };
    const sk = await unwrapSecretKey(v);
    const signed = signDisclosure(receipt, sk);
    scrub(sk);
    const entry = await append(v.store, signed);
    await storeDisclosure(v, receipt.receiptId, red.disclosed);
    return { signed, entry };
  };

  const attempt = async (model) => {
    const body = requestBody(model, cfg.maxTokens, red.disclosed);
    // 2. budget, before any byte leaves
    const payloadBytes = utf8(body).length;
    if (payloadBytes > cfg.maxPayloadBytes) {
      throw new GateRefused(`Refused: ${payloadBytes} bytes exceeds the ${cfg.maxPayloadBytes} byte ceiling. Nothing was sent.`);
    }
    // 3. hash on the receipt, 4. send through the relay
    const controller = new AbortController();
    const timer = cfg.timeoutMs ? setTimeout(() => controller.abort(), cfg.timeoutMs) : null;
    let res;
    let text;
    try {
      res = await transport(cfg.relayUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
      text = await res.text();
    } catch (e) {
      const timedOut = controller.signal.aborted;
      await receiptFor(model, body, '', null, timedOut ? 'timeout' : 'error');
      throw new Unanswered(timedOut ? `${model} did not answer within ${cfg.timeoutMs} ms` : `${model} could not be reached: ${e.message}`, timedOut ? 'timeout' : 'error');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      // The relay refused before forwarding (4xx other than 429): nothing reached the model, but
      // the bytes did leave this page, so they are receipted all the same.
      await receiptFor(model, body, text, null, 'error');
      const msg = `The relay returned ${res.status}: ${text.slice(0, 300)}`;
      if (res.status === 429 || res.status >= 500) throw new Unanswered(msg, 'error');
      throw new Error(msg);
    }
    const json = JSON.parse(text);
    const usage = json.usage ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 } : null;
    const { signed, entry } = await receiptFor(model, body, text, usage);
    const choice = json.choices?.[0];
    const rawAnswer = stripThinking(choice?.message?.content ?? '');
    if (!rawAnswer || choice?.finish_reason === 'length') {
      const why = choice?.finish_reason === 'length' ? 'the model spent its whole token budget reasoning' : 'the model returned no visible content';
      throw new Error(`Empty answer: ${why}. The disclosure was still receipted as entry ${entry.seq}.`);
    }
    return { rawAnswer, signed, entry };
  };

  let out;
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
  return { answer: rehydrate(out.rawAnswer, red.map), rawAnswer: out.rawAnswer, disclosed: red.disclosed, signed: out.signed, entry: out.entry, ms: Date.now() - started, model, fellBack };
}

/**
 * On-device embeddings in the browser: the same MiniLM model and the same
 * tokeniser as the desktop, running as WebAssembly in this tab.
 *
 * The only fetch here is for the model's own files, from this origin, and each
 * is checked against the pinned SHA-256 before it runs. No note, question or
 * vector is ever sent anywhere by this file.
 */
import { encode, meanPool, parseVocab, serialised } from './core/vector.js';
import { sha256 } from './wcrypto.js';

/** Must equal MODEL in src/embed.ts. test/web.test.ts checks that it does. */
export const MODEL = {
  name: 'all-MiniLM-L6-v2 (int8)',
  onnx: 'minilm-l6-v2-int8.onnx',
  onnxSha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
  vocab: 'minilm-l6-v2-vocab.txt',
  vocabSha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  maxTokens: 256,
};

const base = new URL('../', import.meta.url);

async function asset(path) {
  const res = await fetch(new URL(path, base));
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/** null when the model is not deployed, so the page falls back to BM25 and says so. */
export async function loadEmbedder() {
  const [onnx, vocabBytes] = await Promise.all([asset(`models/${MODEL.onnx}`), asset(`models/${MODEL.vocab}`)]);
  if (!onnx || !vocabBytes) return null;
  if (sha256(onnx) !== MODEL.onnxSha256 || sha256(vocabBytes) !== MODEL.vocabSha256) {
    throw new Error('The embedding model served to this page does not match its pinned SHA-256. Refusing to run it.');
  }
  const ort = await import('../vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', base).href;
  const session = await ort.InferenceSession.create(onnx);
  const vocab = parseVocab(new TextDecoder().decode(vocabBytes));

  const embed = serialised(async (text) => {
    const ids = encode(text, vocab, MODEL.maxTokens);
    const n = ids.length;
    const tensor = (a) => new ort.Tensor('int64', BigInt64Array.from(a, (x) => BigInt(x)), [1, n]);
    const feeds = { input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)) };
    if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
    const out = await session.run(feeds);
    const hidden = out[session.outputNames[0]];
    return meanPool(hidden.data, n, hidden.dims[2]);
  });
  return { name: MODEL.name, embed };
}

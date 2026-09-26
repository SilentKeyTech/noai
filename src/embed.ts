/**
 * On-device sentence embeddings. The model runs in this process as WebAssembly
 * (onnxruntime-web), so the corpus is never sent anywhere to be embedded.
 *
 * Model: all-MiniLM-L6-v2, int8 quantised, 384 dimensions, about 22 MB. It is
 * fetched once at install time by scripts/fetch-model.ts, never at runtime, and
 * its SHA-256 is checked here before a single byte of it is executed.
 *
 * WebAssembly rather than a native addon on purpose: the build box runs Windows
 * Smart App Control, which blocks unsigned native DLLs, and the same module runs
 * unchanged in the browser build. The pure half lives in vector.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './crypto.ts';
import { type Embedder, encode, meanPool, parseVocab, serialised } from './vector.ts';

export type { Embedder } from './vector.ts';
export { cosine } from './vector.ts';

export const MODEL = {
  name: 'all-MiniLM-L6-v2 (int8)',
  onnx: 'minilm-l6-v2-int8.onnx',
  onnxSha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
  vocab: 'minilm-l6-v2-vocab.txt',
  vocabSha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  maxTokens: 256,
} as const;

export function modelDir(): string {
  return process.env.NOAI_MODEL_DIR ?? new URL('../models/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

type Ort = typeof import('onnxruntime-web');

/**
 * Returns null, not an error, when the model or the runtime is absent, so NOAI
 * still answers with BM25 alone. The caller reports which retriever it used.
 */
export async function loadEmbedder(dir = modelDir()): Promise<Embedder | null> {
  const onnxPath = join(dir, MODEL.onnx);
  const vocabPath = join(dir, MODEL.vocab);
  if (!existsSync(onnxPath) || !existsSync(vocabPath)) return null;

  const onnxBytes = readFileSync(onnxPath);
  const vocabText = readFileSync(vocabPath, 'utf8');
  if (sha256(onnxBytes) !== MODEL.onnxSha256 || sha256(vocabText) !== MODEL.vocabSha256) {
    throw new Error(`The embedding model in ${dir} does not match its pinned SHA-256. Refusing to run it.`);
  }

  let ort: Ort;
  try {
    ort = await import('onnxruntime-web');
  } catch {
    return null;
  }
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(onnxBytes);
  const vocab = parseVocab(vocabText);

  const embed = serialised(async (text: string): Promise<Float32Array> => {
    const ids = encode(text, vocab, MODEL.maxTokens);
    const n = ids.length;
    const tensor = (a: number[]) => new ort.Tensor('int64', BigInt64Array.from(a, (x) => BigInt(x)), [1, n]);
    const feeds: Record<string, InstanceType<Ort['Tensor']>> = {
      input_ids: tensor(ids),
      attention_mask: tensor(ids.map(() => 1)),
    };
    if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
    const out = await session.run(feeds);
    const hidden = out[session.outputNames[0] as string] as InstanceType<Ort['Tensor']>;
    return meanPool(hidden.data as Float32Array, n, hidden.dims[2] as number);
  });

  return { name: MODEL.name, embed };
}

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
 * unchanged in the browser build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './crypto.ts';

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

export interface Embedder {
  readonly name: string;
  embed(text: string): Promise<Float32Array>;
}

/** BERT uncased basic tokenisation: lowercase, strip accents, split on whitespace and punctuation. */
export function basicTokens(text: string): string[] {
  const t = text.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  return t.split(/\s+/).flatMap((w) => w.split(/([\p{P}\p{S}])/u)).filter(Boolean);
}

/** Greedy longest-match WordPiece, as the model was trained. */
export function wordPiece(word: string, vocab: Map<string, number>): number[] {
  const unk = vocab.get('[UNK]') ?? 100;
  if (word.length > 100) return [unk];
  const out: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let id: number | undefined;
    while (start < end) {
      id = vocab.get((start ? '##' : '') + word.slice(start, end));
      if (id !== undefined) break;
      end--;
    }
    if (id === undefined) return [unk];
    out.push(id);
    start = end;
  }
  return out;
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
  const vocab = new Map(vocabText.split(/\r?\n/).map((t, i) => [t, i] as const));
  const cls = vocab.get('[CLS]') ?? 101;
  const sep = vocab.get('[SEP]') ?? 102;
  const cache = new Map<string, Float32Array>();
  // One inference at a time. Overlapping run() calls on a single-threaded WASM
  // session never settle, which hung the whole process in testing.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    name: MODEL.name,
    embed(text: string): Promise<Float32Array> {
      const next = queue.then(() => run(text));
      queue = next.catch(() => undefined);
      return next;
    },
  };

  async function run(text: string): Promise<Float32Array> {
    {
      const hit = cache.get(text);
      if (hit) return hit;
      const pieces = basicTokens(text).flatMap((w) => wordPiece(w, vocab)).slice(0, MODEL.maxTokens - 2);
      const ids = [cls, ...pieces, sep];
      const n = ids.length;
      const tensor = (a: number[]) => new ort.Tensor('int64', BigInt64Array.from(a, (x) => BigInt(x)), [1, n]);
      const feeds: Record<string, InstanceType<Ort['Tensor']>> = {
        input_ids: tensor(ids),
        attention_mask: tensor(ids.map(() => 1)),
      };
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
      const out = await session.run(feeds);
      const hidden = out[session.outputNames[0] as string] as InstanceType<Ort['Tensor']>;
      const data = hidden.data as Float32Array;
      const dim = hidden.dims[2] as number;
      // Mean pooling over tokens, then L2 normalisation, as the model card specifies.
      const v = new Float32Array(dim);
      for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) v[d] = (v[d] as number) + (data[i * dim + d] as number) / n;
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d++) v[d] = (v[d] as number) / norm;
      cache.set(text, v);
      return v;
    }
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

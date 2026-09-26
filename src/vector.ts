/**
 * The parts of embedding that are pure arithmetic and text handling, shared by
 * the Node embedder (embed.ts) and the browser build. No I/O, no platform APIs.
 */

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

export function parseVocab(text: string): Map<string, number> {
  return new Map(text.split(/\r?\n/).map((t, i) => [t, i] as const));
}

/** [CLS] tokens [SEP], truncated to the model's window. */
export function encode(text: string, vocab: Map<string, number>, maxTokens: number): number[] {
  const pieces = basicTokens(text).flatMap((w) => wordPiece(w, vocab)).slice(0, maxTokens - 2);
  return [vocab.get('[CLS]') ?? 101, ...pieces, vocab.get('[SEP]') ?? 102];
}

/** Mean pooling over tokens, then L2 normalisation, as the model card specifies. */
export function meanPool(hidden: Float32Array, tokens: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < tokens; i++) for (let d = 0; d < dim; d++) v[d] = (v[d] as number) + (hidden[i * dim + d] as number) / tokens;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) v[d] = (v[d] as number) / norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/**
 * One inference at a time. Overlapping run() calls on a single-threaded WASM
 * session never settle, which hung the whole process in testing.
 */
export function serialised<T>(fn: (text: string) => Promise<T>): (text: string) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, T>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return Promise.resolve(hit);
    const next = queue.then(async () => {
      const v = await fn(text);
      cache.set(text, v);
      return v;
    });
    queue = next.catch(() => undefined);
    return next;
  };
}

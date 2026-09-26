/**
 * On-device retrieval. The question and the corpus are ranked here, in this
 * process, and nothing about either is sent anywhere to do it.
 *
 * BM25 over passages, fused with a local neural embedder running as WASM in
 * this process (embed.ts). What NOAI never does is call a hosted embedding
 * endpoint: sending the corpus out to be embedded would disclose all of it,
 * which defeats the product.
 */
import { cosine, type Embedder } from './embed.ts';
import type { Chunk, Note } from './types.ts';

export interface Scored {
  chunk: Chunk;
  score: number;
}

export interface Retriever {
  search(question: string, k: number): Scored[];
}

const STOP = new Set(
  'a an and are as at be but by do does did for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your'.split(' '),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * One passage per paragraph, and long paragraphs split at sentence ends.
 * Small passages are deliberate: the unit of retrieval is the unit of
 * disclosure, so a question about a birthday does not ship the whole note.
 */
export function chunkNote(note: Note, maxChars = 400): Chunk[] {
  const out: Chunk[] = [];
  const push = (text: string): void => {
    if (text.trim()) out.push({ noteId: note.id, title: note.title, index: out.length, text: text.trim() });
  };
  for (const para of note.body.split(/\n\s*\n/)) {
    if (para.length <= maxChars) {
      push(para);
      continue;
    }
    let buf = '';
    for (const s of para.match(/[^.!?]+[.!?]*\s*/g) ?? [para]) {
      if (buf && buf.length + s.length > maxChars) {
        push(buf);
        buf = '';
      }
      buf += s;
    }
    push(buf);
  }
  return out;
}

export class Bm25Retriever implements Retriever {
  private readonly docs: { chunk: Chunk; tf: Map<string, number>; len: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;
  private readonly k1 = 1.4;
  private readonly b = 0.75;

  constructor(notes: Note[]) {
    this.docs = notes.flatMap((n) => chunkNote(n)).map((chunk) => {
      const toks = tokens(`${chunk.title} ${chunk.text}`);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { chunk, tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  get chunks(): Chunk[] {
    return this.docs.map((d) => d.chunk);
  }

  search(question: string, k: number): Scored[] {
    return this.scoreAll(question)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Every passage with its BM25 score, in corpus order, zeros included. */
  scoreAll(question: string): Scored[] {
    const q = [...new Set(tokens(question))];
    const n = this.docs.length;
    return this.docs
      .map((d) => {
        let score = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const df = this.df.get(t) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
        }
        return { chunk: d.chunk, score };
      });
  }
}

/**
 * BM25 and on-device embeddings, fused. BM25 alone misses "doctor" against a
 * note that says "GP". Embeddings alone ranked the lease renewal above the rent
 * for "when do I pay the landlord". Together they get both.
 *
 * Each signal is scaled to 0..1 against its own best passage, then averaged.
 * Cosine below FLOOR counts as no match, so an unrelated note never rides along
 * on a weak semantic resemblance. What the fused score feeds is disclosure, so
 * the floor errs towards sending less.
 */
export const COSINE_FLOOR = 0.2;

export class HybridRetriever {
  private readonly bm25: Bm25Retriever;
  private readonly embedder: Embedder;
  private vectors: Float32Array[] | null = null;

  constructor(notes: Note[], embedder: Embedder) {
    this.bm25 = new Bm25Retriever(notes);
    this.embedder = embedder;
  }

  async search(question: string, k: number): Promise<Scored[]> {
    const chunks = this.bm25.chunks;
    this.vectors ??= await Promise.all(chunks.map((c) => this.embedder.embed(`${c.title}. ${c.text}`)));
    const q = await this.embedder.embed(question);
    const bm = this.bm25.scoreAll(question).map((s) => s.score);
    const cos = this.vectors.map((v) => cosine(q, v));
    const maxBm = Math.max(0, ...bm);
    const maxCos = Math.max(COSINE_FLOOR, ...cos);
    return chunks
      .map((chunk, i) => {
        const b = maxBm > 0 ? (bm[i] as number) / maxBm : 0;
        const c = maxCos > COSINE_FLOOR ? Math.max(0, (cos[i] as number) - COSINE_FLOOR) / (maxCos - COSINE_FLOOR) : 0;
        return { chunk, score: (b + c) / 2 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

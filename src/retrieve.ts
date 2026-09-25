/**
 * On-device retrieval. The question and the corpus are ranked here, in this
 * process, and nothing about either is sent anywhere to do it.
 *
 * This is BM25 over passages, zero dependencies. The Retriever interface is the
 * seam where a local neural embedder (WASM, still on device) plugs in later.
 * What NOAI never does is call a hosted embedding endpoint: sending the corpus
 * out to be embedded would disclose all of it, which defeats the product.
 */
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

  search(question: string, k: number): Scored[] {
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
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

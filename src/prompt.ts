/**
 * What goes to the model, built identically on every platform. The Node gate
 * and the browser gate both call these, so a disclosure made in the browser is
 * byte for byte what the desktop would have sent.
 */
import { redactAll } from './redact.ts';
import type { Chunk } from './types.ts';

export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const FAST_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

export const SYSTEM = [
  'You are NOAI, a private assistant. You only see the passages below, chosen and redacted on the owner\'s device.',
  'Answer from the passages and the question only. If they do not contain the answer, say so plainly.',
  'Values like [EMAIL_1] or [PHONE_2] are placeholders for redacted data. Use them exactly as written, never guess what they stand for.',
  'Be brief. Cite passages as [P1], [P2].',
  'If the question itself tells you a new lasting fact about the owner (a new doctor, a changed date, a new number), end with one extra line of the form "REMEMBER: <the fact as one sentence>", keeping any placeholders exactly as written. Never add that line for facts already in the passages, and never for anything you inferred.',
].join(' ');

export function buildPrompt(question: string, passages: { title: string; text: string }[]): string {
  const ctx = passages.map((p, i) => `[P${String(i + 1)}] ${p.title}\n${p.text}`).join('\n\n');
  return `PASSAGES\n${ctx || '(none matched)'}\n\nQUESTION\n${question}`;
}

/** Nemotron and other reasoning models may put their thinking inline. It is not part of the answer. */
export function stripThinking(text: string): string {
  return text.replace(/^[\s\S]*?<\/think>/, '').trim();
}

/** Redact the question and passages with one placeholder space, and build the disclosed prompt. */
export function prepareDisclosure(question: string, chunks: Chunk[]): { disclosed: string; counts: Record<string, number>; map: Map<string, string> } {
  const red = redactAll([question, ...chunks.flatMap((c) => [c.title, c.text])]);
  const [q = '', ...rest] = red.texts;
  const passages = chunks.map((_, i) => ({ title: rest[i * 2] ?? '', text: rest[i * 2 + 1] ?? '' }));
  return { disclosed: buildPrompt(q, passages), counts: red.counts, map: red.map };
}

/** The exact request body. Its SHA-256 is what the receipt attests to. */
export function requestBody(model: string, maxTokens: number, disclosed: string): string {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: disclosed },
    ],
  });
}

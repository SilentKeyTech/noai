/**
 * The agent loop for one turn: rank on device, disclose the minimum through
 * the gate, return the answer with its receipt, and keep what should be kept.
 *
 * Memory has two routes into the vault, and neither sends the memory anywhere:
 *   - the owner says "remember that ...": saved on device, no model call at all
 *   - the model ends a reply with "REMEMBER: ...": rehydrated on device, then
 *     sealed. The model only ever saw placeholders, so what it asks to keep is
 *     turned back into the real values here, never on the server.
 */
import { type Embedder, loadEmbedder } from './embed.ts';
import { disclose, type GateConfig, type GateResult, type Transport, httpTransport } from './gate.ts';
import { MEMORY_TITLE, minimalSet, rememberIntent, splitMemories } from './memory.ts';
import { peopleFromNotes } from './people.ts';
import { Bm25Retriever, HybridRetriever, type Scored } from './retrieve.ts';
import { detectSkill, type Skill, skillQuestion, splitReminders } from './skills.ts';
import type { Note } from './types.ts';
import { addNote, type OpenVault, readNotes } from './vault.ts';

export interface AskResult extends GateResult {
  candidates: number;
  used: number;
  /** which ranking chose the passages, so the tape can say so */
  retriever: 'hybrid' | 'bm25';
  /** facts the model asked to keep, already sealed into the vault */
  remembered: Note[];
  /** reminders the model set, sealed into the vault with their due date as the title */
  reminders: Note[];
  /** the skill that shaped the question, if any */
  skill: Skill['id'] | null;
}

export interface RememberResult {
  kind: 'memory';
  note: Note;
  /** always zero: saving a memory discloses nothing */
  bytesSent: 0;
}

let embedderPromise: Promise<Embedder | null> | null = null;

/** Loaded once per process. Absent model means BM25 alone, which is reported, not hidden. */
export function sharedEmbedder(): Promise<Embedder | null> {
  embedderPromise ??= loadEmbedder().catch((e: unknown) => {
    console.error(`Embedding model not used: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  return embedderPromise;
}

export { rememberIntent, splitMemories } from './memory.ts';

export async function remember(v: OpenVault, fact: string): Promise<RememberResult> {
  const clean = fact.replace(/\s+/g, ' ').trim();
  // Repeating the fact in the title would send the fact twice.
  return { kind: 'memory', note: await addNote(v, MEMORY_TITLE, clean, 'memory'), bytesSent: 0 };
}

export async function ask(
  v: OpenVault,
  cfg: GateConfig,
  question: string,
  k = 3,
  transport: Transport = httpTransport,
  embedder: Embedder | null | undefined = undefined,
  skill: Skill | null = null,
): Promise<AskResult> {
  const notes = readNotes(v);
  const emb = embedder === undefined ? await sharedEmbedder() : embedder;
  const limit = skill ? skill.passages : k;
  // Ranking uses the owner's words, never the task line a skill adds.
  const hits: Scored[] = limit === 0 ? [] : emb
    ? await new HybridRetriever(notes, emb).search(question, limit * 2)
    : new Bm25Retriever(notes).search(question, limit * 2);
  // Minimal disclosure is the product, not a setting.
  const chosen = minimalSet(hits, limit).map((h) => h.chunk);
  // Every person the vault names is hidden, not only those the chosen passages point at.
  const result = await disclose(v, cfg, skill ? skillQuestion(skill, question) : question, chosen, transport, peopleFromNotes(notes));

  const split = splitReminders(result.answer);
  const { answer, facts } = splitMemories(split.answer);
  const reminders: Note[] = [];
  for (const r of split.reminders) reminders.push(await addNote(v, r.due, r.what, 'reminder'));
  const remembered: Note[] = [];
  for (const f of facts) remembered.push((await remember(v, f)).note);
  return { ...result, answer, candidates: hits.length, used: chosen.length, retriever: emb ? 'hybrid' : 'bm25', remembered, reminders, skill: skill?.id ?? null };
}

/** One turn from the UI or CLI: a memory to keep, or a question to answer. */
export async function respond(
  v: OpenVault,
  cfg: GateConfig,
  text: string,
  transport: Transport = httpTransport,
  embedder?: Embedder | null,
): Promise<RememberResult | ({ kind: 'answer' } & AskResult)> {
  const fact = rememberIntent(text);
  if (fact) return remember(v, fact);
  return { kind: 'answer', ...(await ask(v, cfg, text, 3, transport, embedder, detectSkill(text))) };
}

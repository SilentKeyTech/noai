/**
 * One turn in the browser: a memory to keep on device, or a question answered
 * through the gate. Mirrors src/agent.ts, using the same shared core.
 */
import { MEMORY_TITLE, minimalSet, rememberIntent, splitMemories } from './core/memory.js';
import { Bm25Retriever, HybridRetriever } from './core/retrieve.js';
import { disclose, httpTransport } from './gate.js';
import { addNote, readNotes } from './vault.js';

export async function remember(v, fact) {
  const clean = fact.replace(/\s+/g, ' ').trim();
  return { kind: 'memory', note: await addNote(v, MEMORY_TITLE, clean, 'memory'), bytesSent: 0 };
}

export async function ask(v, cfg, question, { embedder = null, transport = httpTransport, k = 3 } = {}) {
  const notes = await readNotes(v);
  const hits = embedder ? await new HybridRetriever(notes, embedder).search(question, k * 2) : new Bm25Retriever(notes).search(question, k * 2);
  const chosen = minimalSet(hits, k).map((h) => h.chunk);
  const result = await disclose(v, cfg, question, chosen, transport);
  const { answer, facts } = splitMemories(result.answer);
  const remembered = [];
  for (const f of facts) remembered.push((await remember(v, f)).note);
  return { ...result, answer, used: chosen.length, retriever: embedder ? 'hybrid' : 'bm25', remembered };
}

export async function respond(v, cfg, text, opts = {}) {
  const fact = rememberIntent(text);
  if (fact) return remember(v, fact);
  return { kind: 'answer', ...(await ask(v, cfg, text, opts)) };
}

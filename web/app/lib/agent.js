/**
 * One turn in the browser: a memory to keep on device, a skill, or a question
 * answered through the gate. Mirrors src/agent.ts, using the same shared core.
 */
import { MEMORY_TITLE, minimalSet, rememberIntent, splitMemories } from './core/memory.js';
import { Bm25Retriever, HybridRetriever } from './core/retrieve.js';
import { detectSkill, skillQuestion, splitReminders } from './core/skills.js';
import { disclose, httpTransport } from './gate.js';
import { addNote, readNotes } from './vault.js';

export async function remember(v, fact) {
  const clean = fact.replace(/\s+/g, ' ').trim();
  return { kind: 'memory', note: await addNote(v, MEMORY_TITLE, clean, 'memory'), bytesSent: 0 };
}

export async function ask(v, cfg, question, { embedder = null, transport = httpTransport, k = 3, skill = null } = {}) {
  const notes = await readNotes(v);
  const limit = skill ? skill.passages : k;
  // Ranking uses the owner's words, never the task line a skill adds.
  const hits = limit === 0 ? [] : embedder ? await new HybridRetriever(notes, embedder).search(question, limit * 2) : new Bm25Retriever(notes).search(question, limit * 2);
  const chosen = minimalSet(hits, limit).map((h) => h.chunk);
  const result = await disclose(v, cfg, skill ? skillQuestion(skill, question) : question, chosen, transport);
  const split = splitReminders(result.answer);
  const { answer, facts } = splitMemories(split.answer);
  const remembered = [];
  for (const f of facts) remembered.push((await remember(v, f)).note);
  const reminders = [];
  for (const r of split.reminders) reminders.push(await addNote(v, r.due, r.what, 'reminder'));
  return { ...result, answer, used: chosen.length, retriever: embedder ? 'hybrid' : 'bm25', remembered, reminders, skill: skill?.id ?? null };
}

export async function respond(v, cfg, text, opts = {}) {
  const fact = rememberIntent(text);
  if (fact) return remember(v, fact);
  return { kind: 'answer', ...(await ask(v, cfg, text, { ...opts, skill: detectSkill(text) })) };
}

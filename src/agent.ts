/**
 * The agent loop for one question: rank on device, disclose the minimum
 * through the gate, return the answer with its receipt.
 */
import { disclose, type GateConfig, type GateResult, type Transport, httpTransport } from './gate.ts';
import { Bm25Retriever } from './retrieve.ts';
import { type OpenVault, readNotes } from './vault.ts';

export interface AskResult extends GateResult {
  candidates: number;
  used: number;
}

export async function ask(
  v: OpenVault,
  cfg: GateConfig,
  question: string,
  k = 3,
  transport: Transport = httpTransport,
): Promise<AskResult> {
  const retriever = new Bm25Retriever(readNotes(v));
  const hits = retriever.search(question, k * 2);
  // Only passages that score at least a third of the best one go out.
  // Minimal disclosure is the product, not a setting.
  const top = hits[0]?.score ?? 0;
  const chosen = hits.filter((h) => h.score >= top / 3).slice(0, k).map((h) => h.chunk);
  const result = await disclose(v, cfg, question, chosen, transport);
  return { ...result, candidates: hits.length, used: chosen.length };
}

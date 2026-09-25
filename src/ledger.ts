/**
 * The disclosure ledger. Every call that leaves the device produces a signed
 * receipt, and every receipt is linked into a hash chain.
 *
 * A receipt proves one disclosure happened as described and was not altered.
 * The chain proves no disclosure was quietly removed or edited afterwards.
 * Signing and chaining use the same primitives and canonical JSON as BurnKey.
 *
 * Two JSON Lines files, append-only: receipts.jsonl holds the signed receipts,
 * ledger.jsonl holds the chain. Neither contains the disclosed text, only its
 * hash. A verifier needs these files and nothing else: no vault, no network.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, sha256, signBytes, unb64, verifyBytes } from './crypto.ts';
import type { DisclosureReceipt, LedgerEntry, SignedDisclosure } from './types.ts';

export const GENESIS = '0'.repeat(64);

export const ledgerPath = (root: string): string => join(root, 'ledger.jsonl');
export const receiptsPath = (root: string): string => join(root, 'receipts.jsonl');

export function signDisclosure(receipt: DisclosureReceipt, privateKeyDer: Buffer): SignedDisclosure {
  const sig = signBytes(privateKeyDer, Buffer.from(canonical(receipt), 'utf8'));
  return { receipt, signature: sig.toString('base64url') };
}

export function verifyDisclosure(s: SignedDisclosure): boolean {
  if (s?.receipt?.version !== 1 || s.receipt.kind !== 'noai.disclosure') return false;
  return verifyBytes(unb64(s.receipt.signer), Buffer.from(canonical(s.receipt), 'utf8'), unb64(s.signature));
}

export function entryDigest(entry: Omit<LedgerEntry, 'entryHash'>): string {
  return sha256(canonical(entry));
}

async function readLines<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export const readLedger = (root: string): Promise<LedgerEntry[]> => readLines(ledgerPath(root));
export const readReceipts = (root: string): Promise<SignedDisclosure[]> => readLines(receiptsPath(root));

export async function append(root: string, signed: SignedDisclosure): Promise<LedgerEntry> {
  const existing = await readLedger(root);
  const last = existing[existing.length - 1];
  const body = {
    seq: existing.length,
    prev: last ? last.entryHash : GENESIS,
    receiptId: signed.receipt.receiptId,
    at: signed.receipt.at,
    model: signed.receipt.model,
    payloadHash: signed.receipt.payloadHash,
    payloadBytes: signed.receipt.payloadBytes,
    signature: signed.signature,
  };
  const entry: LedgerEntry = { ...body, entryHash: entryDigest(body) };
  await mkdir(root, { recursive: true });
  await appendFile(receiptsPath(root), `${JSON.stringify(signed)}\n`, { mode: 0o600 });
  await appendFile(ledgerPath(root), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

export interface Verdict {
  valid: boolean;
  length: number;
  brokenAt: number | null;
  reason: string;
}

/**
 * Walk the chain from genesis and check each link against its signed receipt.
 * Any edit, deletion, reorder or forged receipt breaks it at a named entry.
 */
export function verifyLedger(entries: LedgerEntry[], receipts: SignedDisclosure[]): Verdict {
  const byId = new Map(receipts.map((r) => [r.receipt.receiptId, r]));
  const bad = (i: number, reason: string): Verdict => ({ valid: false, length: entries.length, brokenAt: i, reason });
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LedgerEntry;
    const { entryHash, ...body } = e;
    if (e.seq !== i) return bad(i, `Entry ${String(i)} is numbered ${String(e.seq)}. A disclosure was removed or reordered.`);
    if (e.prev !== prev) return bad(i, `Entry ${String(i)} does not follow the one before it. The log was cut or spliced.`);
    if (entryDigest(body) !== entryHash) return bad(i, `Entry ${String(i)} was edited after it was written.`);
    const r = byId.get(e.receiptId);
    if (!r) return bad(i, `Entry ${String(i)} has no receipt. The receipt was deleted.`);
    if (!verifyDisclosure(r)) return bad(i, `Receipt for entry ${String(i)} fails its signature. It was altered or forged.`);
    if (r.signature !== e.signature || r.receipt.payloadHash !== e.payloadHash || r.receipt.payloadBytes !== e.payloadBytes) {
      return bad(i, `Receipt for entry ${String(i)} does not match the chain. One of them was altered.`);
    }
    prev = entryHash;
  }
  if (receipts.length !== entries.length) {
    return { valid: false, length: entries.length, brokenAt: entries.length, reason: `${String(receipts.length)} receipts but ${String(entries.length)} chain entries. A disclosure is missing from the chain.` };
  }
  return {
    valid: true,
    length: entries.length,
    brokenAt: null,
    reason: entries.length ? `All ${String(entries.length)} disclosures are intact, signed and in order.` : 'Nothing has left this device yet.',
  };
}

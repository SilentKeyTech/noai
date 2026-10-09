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
 *
 * Appends are written one at a time, whoever calls: two disclosures that end
 * at the same moment get two consecutive entries, not two entries numbered the
 * same. A line a crash cut short reads as a damaged entry, so the chain breaks
 * there when verified and the next receipt can still be written after it.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, sha256, signBytes, unb64, verifyBytes } from './crypto.ts';
import type { DisclosureReceipt, LedgerEntry, SecretUseReceipt, SignedDisclosure, SignedReceipt, SignedSecretUse } from './types.ts';

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

export function signSecretUse(receipt: SecretUseReceipt, privateKeyDer: Buffer): SignedSecretUse {
  const sig = signBytes(privateKeyDer, Buffer.from(canonical(receipt), 'utf8'));
  return { receipt, signature: sig.toString('base64url') };
}

export function verifySecretUse(s: SignedSecretUse): boolean {
  if (s?.receipt?.version !== 1 || s.receipt.kind !== 'noai.secret-use') return false;
  return verifyBytes(unb64(s.receipt.signer), Buffer.from(canonical(s.receipt), 'utf8'), unb64(s.signature));
}

/** Check any receipt the chain may hold. An unknown kind never verifies. */
export function verifyReceipt(s: SignedReceipt): boolean {
  if (s?.receipt?.kind === 'noai.secret-use') return verifySecretUse(s as SignedSecretUse);
  return verifyDisclosure(s as SignedDisclosure);
}

/**
 * The three fields the chain copies from a receipt. For a secret use, "model"
 * names who used it (vault:<client>) and the hash is of the request as the
 * agent wrote it, placeholders intact.
 */
function chainFields(s: SignedReceipt): { model: string; payloadHash: string; payloadBytes: number } {
  const r = s.receipt;
  if (r.kind === 'noai.secret-use') return { model: `vault:${r.client}`, payloadHash: r.requestHash, payloadBytes: r.requestBytes };
  return { model: r.model, payloadHash: r.payloadHash, payloadBytes: r.payloadBytes };
}

export function entryDigest(entry: Omit<LedgerEntry, 'entryHash'>): string {
  return sha256(canonical(entry));
}

/** One record per line. A line that does not parse goes through `damaged`, which keeps it in its place or drops it. */
async function readLines<T>(path: string, damaged: (raw: string) => T | null): Promise<T[]> {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const l of (await readFile(path, 'utf8')).split('\n')) {
    if (!l.trim()) continue;
    let record: T | null;
    try {
      record = JSON.parse(l) as T;
    } catch {
      record = damaged(l);
    }
    if (record !== null) out.push(record);
  }
  return out;
}

/** A chain line that does not parse keeps its place, so the entries after it keep their numbers. Its hash is of the bytes on disk. */
const damagedEntry = (raw: string): LedgerEntry => ({ seq: -1, prev: '', receiptId: '', at: '', model: '', payloadHash: '', payloadBytes: 0, signature: '', entryHash: sha256(raw), damaged: true });

export const readLedger = (root: string): Promise<LedgerEntry[]> => readLines(ledgerPath(root), damagedEntry);
/**
 * Every receipt, of every kind, in order. Typed as disclosures by default for the
 * callers that only ever wrote those; ask for SignedReceipt where secret uses may
 * be on the chain too. A receipt line that does not parse is left out, and the
 * chain entry it belonged to then reads as having no receipt.
 */
export const readReceipts = <T extends SignedReceipt = SignedDisclosure>(root: string): Promise<T[]> => readLines<T>(receiptsPath(root), () => null);

/** A crash can leave a file without its final newline. The next line must not be glued to the cut one. */
async function lineBreak(path: string): Promise<string> {
  if (!existsSync(path)) return '';
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return '';
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    return last[0] === 0x0a ? '' : '\n';
  } finally {
    await fh.close();
  }
}

async function appendNow(root: string, signed: SignedReceipt): Promise<LedgerEntry> {
  const existing = await readLedger(root);
  const last = existing[existing.length - 1];
  const body = {
    seq: existing.length,
    prev: last ? last.entryHash : GENESIS,
    receiptId: signed.receipt.receiptId,
    at: signed.receipt.at,
    ...chainFields(signed),
    signature: signed.signature,
  };
  const entry: LedgerEntry = { ...body, entryHash: entryDigest(body) };
  await mkdir(root, { recursive: true });
  await appendFile(receiptsPath(root), `${await lineBreak(receiptsPath(root))}${JSON.stringify(signed)}\n`, { mode: 0o600 });
  await appendFile(ledgerPath(root), `${await lineBreak(ledgerPath(root))}${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

// One writer at a time, in this process: the next append starts after the last one has read and written.
let writing: Promise<unknown> = Promise.resolve();
export function append(root: string, signed: SignedReceipt): Promise<LedgerEntry> {
  const run = writing.then(() => appendNow(root, signed));
  writing = run.catch(() => undefined);
  return run;
}

/**
 * Every distinct key that signed a receipt, as a short fingerprint. A valid
 * chain proves nothing was edited; it does not prove who wrote it. Compare
 * this against the fingerprint the owner noted when the vault was made.
 */
export function signersOf(receipts: SignedReceipt[]): string[] {
  return [...new Set(receipts.map((r) => sha256(unb64(r.receipt.signer)).slice(0, 16)))];
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
export function verifyLedger(entries: LedgerEntry[], receipts: SignedReceipt[]): Verdict {
  const byId = new Map(receipts.map((r) => [r.receipt.receiptId, r]));
  const bad = (i: number, reason: string): Verdict => ({ valid: false, length: entries.length, brokenAt: i, reason });
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LedgerEntry;
    if (e.damaged) return bad(i, `Entry ${String(i)} cannot be read. The line is damaged or was cut short.`);
    const { entryHash, ...body } = e;
    if (e.seq !== i) return bad(i, `Entry ${String(i)} is numbered ${String(e.seq)}. A disclosure was removed or reordered.`);
    if (e.prev !== prev) return bad(i, `Entry ${String(i)} does not follow the one before it. The log was cut or spliced.`);
    if (entryDigest(body) !== entryHash) return bad(i, `Entry ${String(i)} was edited after it was written.`);
    const r = byId.get(e.receiptId);
    if (!r) return bad(i, `Entry ${String(i)} has no receipt. The receipt was deleted.`);
    if (!verifyReceipt(r)) return bad(i, `Receipt for entry ${String(i)} fails its signature. It was altered or forged.`);
    const f = chainFields(r);
    if (r.signature !== e.signature || f.payloadHash !== e.payloadHash || f.payloadBytes !== e.payloadBytes || f.model !== e.model) {
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

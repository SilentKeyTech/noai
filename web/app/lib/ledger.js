/**
 * The disclosure ledger in the browser. The same records as receipts.jsonl
 * and ledger.jsonl on the desktop, the same canonical JSON, the same chain
 * rule. exportFiles() produces those two files byte for byte, so `noai verify`
 * checks a browser session with no browser involved.
 */
import { canonical, sha256, signBytes, unb64, utf8, verifyBytes, b64 } from './wcrypto.js';

export const GENESIS = '0'.repeat(64);

export const readLedger = async (store) => (await store.get('ledger')) ?? [];
export const readReceipts = async (store) => (await store.get('receipts')) ?? [];

export function signDisclosure(receipt, secretKey) {
  return { receipt, signature: b64(signBytes(secretKey, utf8(canonical(receipt)))) };
}

export function verifyDisclosure(s) {
  if (s?.receipt?.version !== 1 || s.receipt.kind !== 'noai.disclosure') return false;
  return verifyBytes(unb64(s.receipt.signer), utf8(canonical(s.receipt)), unb64(s.signature));
}

export const entryDigest = (body) => sha256(canonical(body));

export async function append(store, signed) {
  const entries = await readLedger(store);
  const receipts = await readReceipts(store);
  const last = entries[entries.length - 1];
  const body = {
    seq: entries.length,
    prev: last ? last.entryHash : GENESIS,
    receiptId: signed.receipt.receiptId,
    at: signed.receipt.at,
    model: signed.receipt.model,
    payloadHash: signed.receipt.payloadHash,
    payloadBytes: signed.receipt.payloadBytes,
    signature: signed.signature,
  };
  const entry = { ...body, entryHash: entryDigest(body) };
  await store.put('receipts', [...receipts, signed]);
  await store.put('ledger', [...entries, entry]);
  return entry;
}

/** Same checks, same wording, as the desktop verifyLedger(). */
export function verifyLedger(entries, receipts) {
  const byId = new Map(receipts.map((r) => [r.receipt.receiptId, r]));
  const bad = (i, reason) => ({ valid: false, length: entries.length, brokenAt: i, reason });
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const { entryHash, ...body } = entries[i];
    if (body.seq !== i) return bad(i, `Entry ${i} is numbered ${body.seq}. A disclosure was removed or reordered.`);
    if (body.prev !== prev) return bad(i, `Entry ${i} does not follow the one before it. The log was cut or spliced.`);
    if (entryDigest(body) !== entryHash) return bad(i, `Entry ${i} was edited after it was written.`);
    const r = byId.get(body.receiptId);
    if (!r) return bad(i, `Entry ${i} has no receipt. The receipt was deleted.`);
    if (!verifyDisclosure(r)) return bad(i, `Receipt for entry ${i} fails its signature. It was altered or forged.`);
    if (r.signature !== body.signature || r.receipt.payloadHash !== body.payloadHash || r.receipt.payloadBytes !== body.payloadBytes) {
      return bad(i, `Receipt for entry ${i} does not match the chain. One of them was altered.`);
    }
    prev = entryHash;
  }
  if (receipts.length !== entries.length) {
    return { valid: false, length: entries.length, brokenAt: entries.length, reason: `${receipts.length} receipts but ${entries.length} chain entries. A disclosure is missing from the chain.` };
  }
  return { valid: true, length: entries.length, brokenAt: null, reason: entries.length ? `All ${entries.length} disclosures are intact, signed and in order.` : 'Nothing has left this device yet.' };
}

/** The two files a verifier needs, as the desktop writes them. */
export async function exportFiles(store) {
  const lines = (xs) => xs.map((x) => `${JSON.stringify(x)}\n`).join('');
  return { 'receipts.jsonl': lines(await readReceipts(store)), 'ledger.jsonl': lines(await readLedger(store)) };
}

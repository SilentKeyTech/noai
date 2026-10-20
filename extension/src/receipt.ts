/**
 * A signed receipt for every message sent on a covered site, chained like the
 * gateway's ledger, so the company can show what left each browser.
 *
 * The receipts are the same shape the gateway writes (DisclosureReceipt in
 * src/types.ts) and the chain is the same (LedgerEntry in src/ledger.ts), so
 * verifyLedger checks an export from the extension unchanged. The signing is
 * WebCrypto Ed25519 here, because src/crypto.ts is built on Node's crypto
 * module and cannot run in a browser; the bytes signed are the same canonical
 * JSON. The key is made in this browser and never leaves it.
 *
 * A receipt holds a hash of what was sent and how many values of each kind
 * were hidden, never the text or the values.
 */
import type { DisclosureReceipt, LedgerEntry, SignedDisclosure } from '../../src/types.ts';

export const GENESIS = '0'.repeat(64);
export const STATEMENT = 'This browser sent exactly the text whose hash is below to the named website, after NOAI+ hid the values counted below.';
export const STATEMENT_AS_WRITTEN = 'This browser sent exactly the text whose hash is below to the named website. The person chose to send it as written: the values counted below were found and NOT hidden.';

/** Same as canonical() in src/crypto.ts: keys sorted, no whitespace. That file cannot be imported here. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',');
  return `{${body}}`;
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const b64url = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// WebCrypto types, named from the global crypto object so this file checks under both the Node and the DOM type libraries.
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const exportJwk = (k: Key) => crypto.subtle.exportKey('jwk', k);
type Jwk = Awaited<ReturnType<typeof exportJwk>>;

export const sha256 = async (s: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', utf8(s)));

export interface Signer {
  privateKey: Key;
  /** SPKI DER, base64url, as the receipts carry it */
  publicKey: string;
}

/** Stored form of the signing key: JWK, kept in extension storage. */
export interface StoredKey {
  privateJwk: Jwk;
  publicKey: string;
}

export async function newSigner(): Promise<{ signer: Signer; stored: StoredKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as { privateKey: Key; publicKey: Key };
  const publicKey = b64url(await crypto.subtle.exportKey('spki', pair.publicKey));
  const privateJwk = await exportJwk(pair.privateKey);
  return { signer: { privateKey: pair.privateKey, publicKey }, stored: { privateJwk, publicKey } };
}

export async function loadSigner(stored: StoredKey): Promise<Signer> {
  const privateKey = await crypto.subtle.importKey('jwk', stored.privateJwk, { name: 'Ed25519' }, false, ['sign']);
  return { privateKey, publicKey: stored.publicKey };
}

export interface SendFacts {
  /** e.g. https://chatgpt.com */
  origin: string;
  /** site id from sites.ts */
  site: string;
  /** exactly what was in the chat box when it was sent */
  text: string;
  counts: Record<string, number>;
  asWritten: boolean;
  staffLabel: string;
  at?: Date;
}

export async function signSend(facts: SendFacts, signer: Signer): Promise<SignedDisclosure> {
  const receipt: DisclosureReceipt = {
    version: 1,
    kind: 'noai.disclosure',
    statement: facts.asWritten ? STATEMENT_AS_WRITTEN : STATEMENT,
    receiptId: crypto.randomUUID(),
    at: (facts.at ?? new Date()).toISOString(),
    endpoint: facts.origin,
    model: `web:${facts.site}`,
    payloadHash: await sha256(facts.text),
    payloadBytes: utf8(facts.text).length,
    sources: [],
    redactions: facts.counts,
    // The website's answer is not seen by the extension at send time.
    responseHash: '',
    usage: null,
    signer: signer.publicKey,
    ...(facts.staffLabel ? { client: facts.staffLabel } : {}),
  };
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, signer.privateKey, utf8(canonical(receipt)));
  return { receipt, signature: b64url(sig) };
}

/** The next link of the chain, as src/ledger.ts writes it. */
export async function chain(signed: SignedDisclosure, last: LedgerEntry | undefined): Promise<LedgerEntry> {
  const body: Omit<LedgerEntry, 'entryHash'> = {
    seq: last ? last.seq + 1 : 0,
    prev: last ? last.entryHash : GENESIS,
    receiptId: signed.receipt.receiptId,
    at: signed.receipt.at,
    model: signed.receipt.model,
    payloadHash: signed.receipt.payloadHash,
    payloadBytes: signed.receipt.payloadBytes,
    signature: signed.signature,
  };
  return { ...body, entryHash: await sha256(canonical(body)) };
}

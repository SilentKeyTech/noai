/**
 * The service worker. It reads the company policy and keeps the signed
 * receipts, one writer at a time so the chain never forks. It makes no
 * network requests.
 */
import type { LedgerEntry, SignedDisclosure } from '../../src/types.ts';
import { mergePolicy, type Policy } from './policy.ts';
import { chain, loadSigner, newSigner, signSend, type SendFacts, type Signer, type StoredKey } from './receipt.ts';

export type Message =
  | { type: 'policy' }
  | { type: 'receipt'; facts: Omit<SendFacts, 'at'> }
  | { type: 'export' }
  | { type: 'forget' };

async function policy(): Promise<Policy> {
  let packed: unknown = null;
  try {
    packed = await (await fetch(chrome.runtime.getURL('policy.json'))).json();
  } catch {
    packed = null;
  }
  let managed: unknown = null;
  try {
    managed = await chrome.storage.managed.get(null);
  } catch {
    managed = null;
  }
  return mergePolicy(packed, managed);
}

let signer: Promise<Signer> | null = null;
function getSigner(): Promise<Signer> {
  signer ??= (async () => {
    const { signingKey } = (await chrome.storage.local.get('signingKey')) as { signingKey?: StoredKey };
    if (signingKey) return loadSigner(signingKey);
    const made = await newSigner();
    await chrome.storage.local.set({ signingKey: made.stored });
    return made.signer;
  })();
  return signer;
}

let writing: Promise<unknown> = Promise.resolve();
function addReceipt(facts: Omit<SendFacts, 'at'>): Promise<SignedDisclosure> {
  const run = writing.then(async () => {
    const signed = await signSend(facts, await getSigner());
    const { receipts = [], ledger = [] } = (await chrome.storage.local.get(['receipts', 'ledger'])) as { receipts?: SignedDisclosure[]; ledger?: LedgerEntry[] };
    const entry = await chain(signed, ledger.at(-1));
    await chrome.storage.local.set({ receipts: [...receipts, signed], ledger: [...ledger, entry] });
    return signed;
  });
  writing = run.catch(() => undefined);
  return run;
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, reply) => {
  const answer = async (): Promise<unknown> => {
    switch (msg.type) {
      case 'policy':
        return policy();
      case 'receipt':
        return (await policy()).receipts ? addReceipt(msg.facts) : null;
      case 'export': {
        const { receipts = [], ledger = [] } = await chrome.storage.local.get(['receipts', 'ledger']);
        return { receipts, ledger, signer: (await getSigner()).publicKey };
      }
      case 'forget':
        await chrome.storage.local.remove('table');
        return true;
    }
  };
  answer().then(reply, (e: unknown) => reply({ error: String(e) }));
  return true;
});

/**
 * Shared shapes for NOAI.
 *
 * The vault, KDF and signing identity follow BurnKey exactly, so the same
 * primitives in crypto.ts serve both products. BurnKey proves a file was
 * destroyed. NOAI proves what was disclosed.
 */

/** Identical to BurnKey's Sealed, so crypto.ts is shared unchanged. */
export interface Sealed {
  iv: string;
  tag: string;
  ct: string;
}

/** Identical to BurnKey's KdfParams. */
export interface KdfParams {
  algorithm: 'scrypt';
  salt: string;
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  addedAt: string;
}

export interface SealedNote {
  id: string;
  /** title and body are both inside `sealed`, nothing readable sits in the file */
  sealed: Sealed;
  addedAt: string;
  bytes: number;
}

export interface Vault {
  version: 1;
  product: 'noai';
  createdAt: string;
  kdf: KdfParams;
  masterKey: Sealed;
  check: Sealed;
  device: { publicKey: string; privateKey: Sealed };
  notes: Record<string, SealedNote>;
  /**
   * The exact redacted text that left the device for each receipt, sealed.
   * The receipt carries only its hash; this lets the owner read it back.
   */
  disclosures: Record<string, Sealed>;
}

/** One passage of a note, the unit the retriever ranks and the gate discloses. */
export interface Chunk {
  noteId: string;
  title: string;
  index: number;
  text: string;
}

/** What the gate attests to for every outbound call. */
export interface DisclosureReceipt {
  version: 1;
  kind: 'noai.disclosure';
  statement: string;
  receiptId: string;
  at: string;
  endpoint: string;
  model: string;
  /** sha256 of the exact request body that left the device */
  payloadHash: string;
  payloadBytes: number;
  /** which passages were included, by note and chunk, never their text */
  sources: { noteId: string; chunk: number; chunkHash: string }[];
  /** how many values of each kind were replaced before sending */
  redactions: Record<string, number>;
  /** sha256 of the model's reply as received */
  responseHash: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  signer: string;
}

export interface SignedDisclosure {
  receipt: DisclosureReceipt;
  signature: string;
}

/** One link in the append-only disclosure log. */
export interface LedgerEntry {
  seq: number;
  prev: string;
  receiptId: string;
  at: string;
  model: string;
  payloadHash: string;
  payloadBytes: number;
  signature: string;
  entryHash: string;
}

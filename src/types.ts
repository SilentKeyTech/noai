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

/** A 'memory' is a fact kept from a conversation; a 'reminder' carries its due date as the title. */
export type NoteKind = 'note' | 'memory' | 'reminder';

export interface Note {
  id: string;
  title: string;
  body: string;
  addedAt: string;
  /** 'memory' is a fact saved from a conversation. Kept inside the seal, like the title. */
  kind?: NoteKind;
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
  /** Agent vault secrets. Name, policy and value are all inside the seal. Absent in vaults made before it. */
  secrets?: Record<string, SealedSecret>;
  /** Bearer token for the local MCP server, sealed so it is only readable once the vault is open. */
  mcpToken?: Sealed;
}

/** One secret an agent may use by placeholder. Nothing readable sits in the file. */
export interface SealedSecret {
  id: string;
  sealed: Sealed;
  addedAt: string;
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
  /** set only when the bytes left but no answer came back: 'timeout' or 'error'. An unanswered disclosure is still a disclosure. */
  outcome?: 'timeout' | 'error';
  /** set by the company gateway: which staff member's token made the call, never the token itself */
  client?: string;
}

export interface SignedDisclosure {
  receipt: DisclosureReceipt;
  signature: string;
}

/**
 * Where a secret may be inserted: header, url or body of an agent's request
 * (the owner allows these per secret), or env and file for a local tool the
 * owner runs themselves with `vault run` (never offered to an agent).
 */
export type Placement = 'header' | 'url' | 'body' | 'env' | 'file';

/**
 * What the gate attests to every time an agent's request names a vault secret,
 * whether it was sent or refused. It never carries the secret value, nor a hash
 * of anything that contains it: a hash of the injected bytes would let anyone
 * holding the receipt test guesses at a weak secret offline.
 */
export interface SecretUseReceipt {
  version: 1;
  kind: 'noai.secret-use';
  statement: string;
  receiptId: string;
  at: string;
  /** the MCP client that asked, as it named itself */
  client: string;
  /** which secrets the request named, by vault id and name, and where it put them. id is null for a name the vault does not hold. */
  secrets: { id: string | null; name: string; placements: Placement[] }[];
  method: string;
  /** destination host, with port if not the default */
  host: string;
  /** the URL path as the agent wrote it, placeholders intact, no query */
  path: string;
  /** sha256 of the request exactly as the agent wrote it, before any secret was inserted */
  requestHash: string;
  requestBytes: number;
  /** sent: the bytes left. refused: nothing left. error: the bytes left and no answer came back. */
  outcome: 'sent' | 'refused' | 'error';
  status: number | null;
  /** why it was refused or failed, in words that contain no secret */
  reason?: string;
  /** sha256 of exactly what was handed back to the agent, after redaction */
  responseHash: string;
  responseBytes: number;
  /** how many copies of a secret were found in the response and blanked */
  echoesRedacted: number;
  signer: string;
}

export interface SignedSecretUse {
  receipt: SecretUseReceipt;
  signature: string;
}

/** Anything the ledger chains: a disclosure to a model or client, or a secret use. */
export type SignedReceipt = SignedDisclosure | SignedSecretUse;

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

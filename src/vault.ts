/**
 * The vault holds the owner's private life, sealed. The file on disk is noise
 * without the passphrase: every note title and body is inside AES-256-GCM, and
 * the keys follow BurnKey's layout (passphrase -> scrypt KEK -> master key).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  b64,
  defaultKdf,
  deriveKek,
  newId,
  newSigningPair,
  open as unseal,
  randomKey,
  scrub,
  seal,
  sha256,
  unb64,
} from './crypto.ts';
import type { Note, NoteKind, Sealed, Vault } from './types.ts';

const CHECK_PHRASE = 'noai.vault.unlocked';

export interface OpenVault {
  path: string;
  data: Vault;
  /** in memory only, for the life of the process */
  masterKey: Buffer;
  /**
   * Set by secrets.ts just before it writes a change to the agent vault. Every
   * other write keeps the secrets as they are on disk, so a long-running server
   * never writes back a secret the owner removed from another window.
   */
  secretsChanged?: boolean;
}

export function vaultPathFor(root: string): string {
  return join(resolve(root), 'vault.json');
}

export async function createVault(root: string, passphrase: string): Promise<OpenVault> {
  const path = vaultPathFor(root);
  if (existsSync(path)) {
    throw new Error(`A vault already exists at ${path}. Delete it deliberately to start over.`);
  }
  const kdf = defaultKdf();
  const kek = deriveKek(passphrase, kdf);
  const masterKey = randomKey();
  const pair = newSigningPair();
  const data: Vault = {
    version: 1,
    product: 'noai',
    createdAt: new Date().toISOString(),
    kdf,
    masterKey: seal(kek, masterKey),
    check: seal(kek, Buffer.from(CHECK_PHRASE, 'utf8')),
    device: { publicKey: b64(pair.publicKey), privateKey: seal(masterKey, pair.privateKey) },
    notes: {},
    disclosures: {},
  };
  scrub(kek, pair.privateKey);
  const v = { path, data, masterKey };
  await writeVault(v);
  return v;
}

export async function openVault(root: string, passphrase: string): Promise<OpenVault> {
  const path = vaultPathFor(root);
  if (!existsSync(path)) throw new Error(`No vault at ${path}. Run "noai init" first.`);
  const data = JSON.parse(await readFile(path, 'utf8')) as Vault;
  if (data.version !== 1 || data.product !== 'noai') {
    throw new Error('This file is not a NOAI vault this build can read.');
  }
  const kek = deriveKek(passphrase, data.kdf);
  let masterKey: Buffer;
  try {
    if (unseal(kek, data.check).toString('utf8') !== CHECK_PHRASE) throw new Error('bad check');
    masterKey = unseal(kek, data.masterKey);
  } catch {
    scrub(kek);
    throw new Error('That passphrase does not open this vault.');
  }
  scrub(kek);
  return { path, data, masterKey };
}

/** Atomic write: new file, then rename over the old one. */
export async function writeVault(v: OpenVault): Promise<void> {
  if (!v.secretsChanged && existsSync(v.path)) {
    const disk = JSON.parse(await readFile(v.path, 'utf8')) as Vault;
    if (disk.device?.publicKey === v.data.device.publicKey) {
      if (disk.secrets) v.data.secrets = disk.secrets;
      else delete v.data.secrets;
      if (disk.mcpToken) v.data.mcpToken = disk.mcpToken;
      else delete v.data.mcpToken;
    }
  }
  v.secretsChanged = false;
  await mkdir(dirname(v.path), { recursive: true });
  const tmp = `${v.path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(v.data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, v.path);
}

/** The note id is bound in as AAD, so a sealed note cannot be swapped under another id. */
export async function addNote(v: OpenVault, title: string, body: string, kind: NoteKind = 'note'): Promise<Note> {
  const note: Note = { id: newId(), title, body, addedAt: new Date().toISOString(), kind };
  const plain = Buffer.from(JSON.stringify({ title, body, kind }), 'utf8');
  v.data.notes[note.id] = {
    id: note.id,
    sealed: seal(v.masterKey, plain, Buffer.from(note.id, 'utf8')),
    addedAt: note.addedAt,
    bytes: plain.length,
  };
  await writeVault(v);
  return note;
}

export function readNotes(v: OpenVault): Note[] {
  return Object.values(v.data.notes).map((s) => {
    const { title, body, kind } = JSON.parse(
      unseal(v.masterKey, s.sealed, Buffer.from(s.id, 'utf8')).toString('utf8'),
    ) as { title: string; body: string; kind?: NoteKind };
    return { id: s.id, title, body, addedAt: s.addedAt, kind: kind ?? 'note' };
  });
}

/** Forgetting is a real delete of the sealed entry, not a flag. */
export async function forgetNote(v: OpenVault, id: string): Promise<boolean> {
  if (!v.data.notes[id]) return false;
  delete v.data.notes[id];
  await writeVault(v);
  return true;
}

export async function storeDisclosure(v: OpenVault, receiptId: string, text: string): Promise<void> {
  v.data.disclosures[receiptId] = seal(v.masterKey, Buffer.from(text, 'utf8'), Buffer.from(receiptId, 'utf8'));
  await writeVault(v);
}

export function readDisclosure(v: OpenVault, receiptId: string): string | null {
  const s: Sealed | undefined = v.data.disclosures[receiptId];
  if (!s) return null;
  return unseal(v.masterKey, s, Buffer.from(receiptId, 'utf8')).toString('utf8');
}

export function unwrapPrivateKey(v: OpenVault): Buffer {
  return unseal(v.masterKey, v.data.device.privateKey);
}

export function signerFingerprint(publicKeyB64: string): string {
  return sha256(unb64(publicKeyB64)).slice(0, 16);
}

export function closeVault(v: OpenVault): void {
  scrub(v.masterKey);
}

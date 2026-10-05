/**
 * The browser vault. Same layout as the desktop vault.json: passphrase ->
 * scrypt KEK -> random master key -> every note sealed with its id as AAD.
 * What IndexedDB holds is noise without the passphrase.
 *
 * One difference, recorded in the file: the device private key is sealed as a
 * raw 32 byte Ed25519 seed (device.format), where the desktop seals PKCS8 DER.
 * The public key is SPKI DER on both, so receipts verify anywhere.
 */
import { b64, defaultKdf, deriveKek, fromUtf8, newId, newSigningPair, open, randomBytes, scrub, seal, sha256, unb64, utf8 } from './wcrypto.js';

const CHECK_PHRASE = 'noai.vault.unlocked';
const KEY = 'vault';

export async function vaultExists(store) {
  return (await store.get(KEY)) !== undefined;
}

export async function createVault(store, passphrase, onProgress) {
  if (await vaultExists(store)) throw new Error('A vault already exists in this browser.');
  const kdf = defaultKdf();
  const kek = await deriveKek(passphrase, kdf, onProgress);
  const masterKey = randomBytes(32);
  const pair = newSigningPair();
  const data = {
    version: 1,
    product: 'noai',
    createdAt: new Date().toISOString(),
    kdf,
    masterKey: await seal(kek, masterKey),
    check: await seal(kek, utf8(CHECK_PHRASE)),
    device: { publicKey: b64(pair.publicKeySpki), privateKey: await seal(masterKey, pair.secretKey), format: 'ed25519-raw' },
    notes: {},
    disclosures: {},
  };
  scrub(kek, pair.secretKey);
  const v = { store, data, masterKey };
  await writeVault(v);
  return v;
}

export async function openVault(store, passphrase, onProgress) {
  const data = await store.get(KEY);
  if (!data) throw new Error('No vault in this browser yet.');
  const kek = await deriveKek(passphrase, data.kdf, onProgress);
  try {
    if (fromUtf8(await open(kek, data.check)) !== CHECK_PHRASE) throw new Error('bad check');
    const masterKey = await open(kek, data.masterKey);
    return { store, data, masterKey };
  } catch {
    throw new Error('That passphrase does not open this vault.');
  } finally {
    scrub(kek);
  }
}

export const writeVault = (v) => v.store.put(KEY, v.data);

export async function addNote(v, title, body, kind = 'note') {
  const note = { id: newId(), title, body, addedAt: new Date().toISOString(), kind };
  const plain = utf8(JSON.stringify({ title, body, kind }));
  v.data.notes[note.id] = { id: note.id, sealed: await seal(v.masterKey, plain, utf8(note.id)), addedAt: note.addedAt, bytes: plain.length };
  await writeVault(v);
  return note;
}

export async function readNotes(v) {
  const out = [];
  for (const s of Object.values(v.data.notes)) {
    const { title, body, kind } = JSON.parse(fromUtf8(await open(v.masterKey, s.sealed, utf8(s.id))));
    out.push({ id: s.id, title, body, addedAt: s.addedAt, kind: kind ?? 'note' });
  }
  return out;
}

export async function forgetNote(v, id) {
  if (!v.data.notes[id]) return false;
  delete v.data.notes[id];
  await writeVault(v);
  return true;
}

export async function storeDisclosure(v, receiptId, text) {
  v.data.disclosures[receiptId] = await seal(v.masterKey, utf8(text), utf8(receiptId));
  await writeVault(v);
}

export async function readDisclosure(v, receiptId) {
  const s = v.data.disclosures[receiptId];
  return s ? fromUtf8(await open(v.masterKey, s, utf8(receiptId))) : null;
}

/** The owner's own settings (what the companion calls them), sealed like a note and never retrieved or sent. */
export async function saveProfile(v, profile) {
  v.data.profile = await seal(v.masterKey, utf8(JSON.stringify(profile)), utf8('profile'));
  await writeVault(v);
}

export async function readProfile(v) {
  return v.data.profile ? JSON.parse(fromUtf8(await open(v.masterKey, v.data.profile, utf8('profile')))) : {};
}

export const unwrapSecretKey = (v) => open(v.masterKey, v.data.device.privateKey);
export const signerFingerprint = (publicKeyB64) => sha256(unb64(publicKeyB64)).slice(0, 16);

export function closeVault(v) {
  scrub(v.masterKey);
}

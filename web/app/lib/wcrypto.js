/**
 * Every cryptographic operation in the browser build, in one file.
 *
 * AES-256-GCM and randomness come from WebCrypto. WebCrypto has no scrypt, and
 * Ed25519 support still varies by browser, so those come from the audited
 * noble libraries, vendored and served from this origin.
 *
 * The shapes match the desktop build exactly: Sealed is { iv, tag, ct } in
 * base64url, the KDF is scrypt N=2^17 r=8 p=1, and the device public key is
 * Ed25519 in SPKI DER. So a receipt signed here verifies with `noai verify`.
 */
import { scryptAsync } from '../vendor/noble-hashes/scrypt.js';
import { sha256 as nobleSha256 } from '../vendor/noble-hashes/sha2.js';
import { bytesToHex } from '../vendor/noble-hashes/utils.js';
import { ed25519 } from '../vendor/noble-curves/ed25519.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);

export function b64(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export const newId = () => b64(randomBytes(9));
export const sha256 = (data) => bytesToHex(nobleSha256(typeof data === 'string' ? utf8(data) : data));

export function defaultKdf() {
  return { algorithm: 'scrypt', salt: b64(randomBytes(16)), N: 131072, r: 8, p: 1, keyLength: 32 };
}

export async function deriveKek(passphrase, kdf, onProgress) {
  return scryptAsync(utf8(passphrase.normalize('NFKC')), unb64(kdf.salt), {
    N: kdf.N, r: kdf.r, p: kdf.p, dkLen: kdf.keyLength, maxmem: 256 * 1024 * 1024, onProgress,
  });
}

const aesKey = (raw, usage) => subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);

/** WebCrypto returns ciphertext||tag. Split it so the stored shape matches the desktop's. */
export async function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const params = { name: 'AES-GCM', iv, tagLength: 128, ...(aad ? { additionalData: aad } : {}) };
  const out = new Uint8Array(await subtle.encrypt(params, await aesKey(key, 'encrypt'), plaintext));
  return { iv: b64(iv), tag: b64(out.slice(-16)), ct: b64(out.slice(0, -16)) };
}

export async function open(key, sealed, aad) {
  const joined = new Uint8Array([...unb64(sealed.ct), ...unb64(sealed.tag)]);
  const params = { name: 'AES-GCM', iv: unb64(sealed.iv), tagLength: 128, ...(aad ? { additionalData: aad } : {}) };
  return new Uint8Array(await subtle.decrypt(params, await aesKey(key, 'decrypt'), joined));
}

// Ed25519 SubjectPublicKeyInfo is a fixed 12 byte header in front of the raw key.
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

export function newSigningPair() {
  const secret = ed25519.utils.randomSecretKey();
  const raw = ed25519.getPublicKey(secret);
  return { publicKeySpki: new Uint8Array([...SPKI_PREFIX, ...raw]), secretKey: secret };
}

export function signBytes(secretKey, message) {
  return ed25519.sign(message, secretKey);
}

export function verifyBytes(publicKeySpki, message, signature) {
  try {
    if (publicKeySpki.length !== 44 || !SPKI_PREFIX.every((b, i) => publicKeySpki[i] === b)) return false;
    return ed25519.verify(signature, message, publicKeySpki.slice(12));
  } catch {
    return false;
  }
}

/** Deterministic JSON, identical to the desktop's canonical(): keys sorted, no whitespace. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const body = Object.keys(value)
    .sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',');
  return `{${body}}`;
}

/** Best effort: clears our copy. See the desktop crypto.ts for the honest limit. */
export function scrub(...arrays) {
  for (const a of arrays) a?.fill(0);
}

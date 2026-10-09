/**
 * Every cryptographic operation in BurnKey lives here and nowhere else.
 * Node built-ins only, no dependencies, nothing to audit but this file.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from 'node:crypto';
import type { KdfParams, Sealed } from './types.ts';

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** scrypt at these settings needs ~128 MB, so the default 32 MB cap has to go up. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export const b64 = (b: Buffer): string => b.toString('base64url');
export const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function newId(): string {
  return randomBytes(9).toString('base64url');
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function defaultKdf(): KdfParams {
  return {
    algorithm: 'scrypt',
    salt: b64(randomBytes(16)),
    // 2^17 iterations. Slow enough to hurt a cracker, fast enough that unlocking
    // the vault still feels instant to the person who owns it.
    N: 131072,
    r: 8,
    p: 1,
    keyLength: KEY_BYTES,
  };
}

const isPow2 = (n: number): boolean => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

/**
 * The KDF parameters come from the vault file, so they are untrusted input.
 * Reject anything scrypt would choke on, anything that would hand us a key of
 * the wrong size, and anything that would blow past the memory cap, each with
 * a message a person can act on instead of an OpenSSL error code.
 */
export function validateKdf(kdf: unknown): KdfParams {
  const bad: (why: string) => never = (why) => {
    throw new Error(`The vault's key derivation settings are not usable: ${why}.`);
  };
  if (!kdf || typeof kdf !== 'object') bad('missing');
  const k = kdf as Partial<KdfParams>;
  if (k.algorithm !== 'scrypt') bad(`unknown algorithm ${JSON.stringify(k.algorithm)}`);
  if (typeof k.salt !== 'string' || unb64(k.salt).length < 16) bad('salt is missing or too short');
  const { N, r, p } = k;
  if (typeof N !== 'number' || !isPow2(N)) bad('N must be a power of two');
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 1) bad('r must be a positive integer');
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) bad('p must be a positive integer');
  if (k.keyLength !== KEY_BYTES) bad(`keyLength must be ${String(KEY_BYTES)}`);
  if (128 * N * r > SCRYPT_MAXMEM) bad('N and r need more memory than this build allows');
  return k as KdfParams;
}

/** Turn a passphrase into the key encryption key that wraps the master key. */
export function deriveKek(passphrase: string, kdf: KdfParams): Buffer {
  validateKdf(kdf);
  return scryptSync(passphrase.normalize('NFKC'), unb64(kdf.salt), kdf.keyLength, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}

export function isSealed(value: unknown): value is Sealed {
  const s = value as Partial<Sealed> | null;
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.iv === 'string' &&
    typeof s.tag === 'string' &&
    typeof s.ct === 'string'
  );
}

export function open(key: Buffer, sealed: Sealed, aad?: Buffer): Buffer {
  const decipher = createDecipheriv(CIPHER, key, unb64(sealed.iv), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(unb64(sealed.tag));
  if (aad) decipher.setAAD(aad);
  return joinChunks(decipher.update(unb64(sealed.ct)), decipher.final());
}

/**
 * Hand back decrypted output in one buffer the caller can scrub.
 *
 * GCM is a stream mode, so update() returns every byte and final() returns
 * none, and the update() buffer is the one the caller gets. If final() ever
 * does return bytes, the two are copied into one buffer and the originals are
 * zeroed on the spot, because a secret in a buffer nobody holds a reference
 * to is not gone, it is waiting for the allocator to hand the memory out
 * again. Scanning the process after closeVault found a content key that way.
 */
function joinChunks(head: Buffer, tail: Buffer): Buffer {
  if (tail.length === 0) return head;
  const out = Buffer.concat([head, tail]);
  scrub(head, tail);
  return out;
}

/** Raw stream encryption for file bodies, where the IV and tag travel in the blob header. */
export function encryptBody(cek: Buffer, plaintext: Buffer): {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, cek, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

export function decryptBody(
  cek: Buffer,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
): Buffer {
  const decipher = createDecipheriv(CIPHER, cek, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return joinChunks(decipher.update(ciphertext), decipher.final());
}

export function newSigningPair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

export function signBytes(privateKeyDer: Buffer, message: Buffer): Buffer {
  const key = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  return edSign(null, message, key);
}

export function verifyBytes(
  publicKeyDer: Buffer,
  message: Buffer,
  signature: Buffer,
): boolean {
  try {
    const key = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    return edVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function sameSecret(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Deterministic JSON so a signature made here verifies anywhere.
 * Keys sorted, no incidental whitespace.
 */
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

/**
 * Best effort erasure of a buffer we are done with.
 *
 * Honest note: this clears our copy in this process. It cannot reach copies the
 * garbage collector, the swap file, or a hibernation image may already hold.
 * BurnKey does not depend on this for its guarantee, it depends on the key never
 * being written to disk unwrapped in the first place.
 */
export function scrub(...buffers: Buffer[]): void {
  for (const b of buffers) b.fill(0);
}

/**
 * Who may use the company gateway, and who may read its receipts.
 *
 * staff.json sits beside the vault. It holds no token and no password, only
 * their hashes: a stolen file lets nobody in. A token is shown once, when the
 * person is added. Revoking someone takes effect on their next call, because
 * the file is read on every request.
 *
 *   admin  may read the receipts page and revoke staff; needs a password.
 *   staff  may use the gateway with a token, nothing else.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256 } from './crypto.ts';

export type Role = 'admin' | 'staff';

export interface StaffRecord {
  name: string;
  role: Role;
  /** sha256 of the token; the token itself is never stored */
  tokenHash: string;
  /** scrypt of the password, admins only */
  password?: { salt: string; hash: string };
  createdAt: string;
  revokedAt?: string;
}

export const staffPath = (root: string): string => join(root, 'staff.json');

const NAME = /^[A-Za-z0-9._@+-]{1,64}$/;
export const MIN_PASSWORD = 12;

export async function readStaff(root: string): Promise<StaffRecord[]> {
  const p = staffPath(root);
  if (!existsSync(p)) return [];
  return JSON.parse(await readFile(p, 'utf8')) as StaffRecord[];
}

async function writeStaff(root: string, list: StaffRecord[]): Promise<void> {
  const p = staffPath(root);
  await mkdir(dirname(p), { recursive: true });
  // write beside, then rename: a crash never leaves half a file
  await writeFile(`${p}.tmp`, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  await rename(`${p}.tmp`, p);
}

const hashPassword = (password: string, salt: Buffer): Buffer => scryptSync(password.normalize('NFKC'), salt, 32);

/** Add a person. Returns the token, which is shown once and cannot be recovered. */
export async function addStaff(root: string, name: string, role: Role = 'staff', password?: string): Promise<{ record: StaffRecord; token: string }> {
  if (!NAME.test(name)) throw new Error('A name is letters, digits and . _ @ + - only, up to 64 characters.');
  const list = await readStaff(root);
  if (list.some((s) => s.name === name && !s.revokedAt)) throw new Error(`${name} already exists. Revoke them first to replace.`);
  if (role === 'admin' && (!password || password.length < MIN_PASSWORD)) throw new Error(`An admin needs a password of at least ${String(MIN_PASSWORD)} characters.`);
  const token = `noai_${randomBytes(24).toString('base64url')}`;
  const record: StaffRecord = { name, role, tokenHash: sha256(token), createdAt: new Date().toISOString() };
  if (role === 'admin' && password) {
    const salt = randomBytes(16);
    record.password = { salt: salt.toString('base64url'), hash: hashPassword(password, salt).toString('base64url') };
  }
  await writeStaff(root, [...list.filter((s) => s.name !== name), record]);
  return { record, token };
}

export async function revokeStaff(root: string, name: string): Promise<boolean> {
  const list = await readStaff(root);
  const who = list.find((s) => s.name === name && !s.revokedAt);
  if (!who) return false;
  who.revokedAt = new Date().toISOString();
  await writeStaff(root, list);
  return true;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The person this bearer token belongs to, or null. Every record is compared, in constant time. */
export async function authenticateToken(root: string, header: string | undefined): Promise<{ name: string; role: Role } | null> {
  const token = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
  if (!token) return null;
  const given = sha256(token);
  let found: StaffRecord | null = null;
  for (const s of await readStaff(root)) if (same(given, s.tokenHash) && !s.revokedAt) found = s;
  return found ? { name: found.name, role: found.role } : null;
}

/** Check an admin's password. A wrong name costs the same time as a wrong password. */
export async function checkPassword(root: string, name: string, password: string): Promise<boolean> {
  const who = (await readStaff(root)).find((s) => s.name === name && !s.revokedAt && s.role === 'admin' && s.password);
  const salt = who?.password ? Buffer.from(who.password.salt, 'base64url') : Buffer.alloc(16);
  const got = hashPassword(password, salt).toString('base64url');
  return !!who?.password && same(got, who.password.hash);
}

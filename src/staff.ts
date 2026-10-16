/**
 * Who may use the company gateway, and who may read its receipts.
 *
 * staff.json sits beside the vault. It holds no token and no password, only
 * their hashes: a stolen file lets nobody in. A token is shown once, when the
 * person is added. Revoking someone takes effect on their next call, because
 * the file is read on every request.
 *
 *   admin  may read the receipts page, revoke staff and set their access; needs a password.
 *   staff  may use the gateway with a token, nothing else.
 *
 * Access is per person and read on every request, like revoking:
 *   paused     the token still exists but every AI call is refused
 *   models     only these model ids; absent means every listed model
 *   showReal   false leaves the placeholders in the answer, so this person
 *              never sees the real values the gateway hid
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256 } from './crypto.ts';

export type Role = 'admin' | 'staff';

export interface Access {
  paused?: boolean;
  models?: string[];
  showReal?: boolean;
}

/** What a person may do. No access record means everything. */
export const accessOf = (s: Pick<StaffRecord, 'access'> | null | undefined): { paused: boolean; models: string[] | null; showReal: boolean } => ({
  paused: s?.access?.paused === true,
  models: s?.access?.models?.length ? [...s.access.models] : null,
  showReal: s?.access?.showReal !== false,
});

export interface StaffRecord {
  name: string;
  role: Role;
  access?: Access;
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

const MODEL_ID = /^[\w./:@+-]{1,200}$/;

/**
 * Change what one active person may do. Only the fields given change;
 * `models: []` or `null` lifts the model limit.
 */
export async function setAccess(root: string, name: string, patch: { paused?: boolean; models?: string[] | null; showReal?: boolean }): Promise<StaffRecord | null> {
  const list = await readStaff(root);
  const who = list.find((s) => s.name === name && !s.revokedAt);
  if (!who) return null;
  const next: Access = { ...who.access };
  if (patch.paused !== undefined) next.paused = patch.paused === true;
  if (patch.showReal !== undefined) next.showReal = patch.showReal !== false;
  if (patch.models !== undefined) {
    const ids = [...new Set((patch.models ?? []).map((m) => m.trim()).filter(Boolean))];
    const bad = ids.find((m) => !MODEL_ID.test(m));
    if (bad !== undefined) throw new Error(`"${bad.slice(0, 40)}" is not a model id.`);
    if (ids.length) next.models = ids;
    else delete next.models;
  }
  who.access = next;
  await writeStaff(root, list);
  return who;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The person this bearer token belongs to, or null. Every record is compared, in constant time. */
export async function authenticateToken(root: string, header: string | undefined): Promise<{ name: string; role: Role; access: ReturnType<typeof accessOf> } | null> {
  const token = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
  if (!token) return null;
  const given = sha256(token);
  let found: StaffRecord | null = null;
  for (const s of await readStaff(root)) if (same(given, s.tokenHash) && !s.revokedAt) found = s;
  return found ? { name: found.name, role: found.role, access: accessOf(found) } : null;
}

/** Check an admin's password. A wrong name costs the same time as a wrong password. */
export async function checkPassword(root: string, name: string, password: string): Promise<boolean> {
  const who = (await readStaff(root)).find((s) => s.name === name && !s.revokedAt && s.role === 'admin' && s.password);
  const salt = who?.password ? Buffer.from(who.password.salt, 'base64url') : Buffer.alloc(16);
  const got = hashPassword(password, salt).toString('base64url');
  return !!who?.password && same(got, who.password.hash);
}

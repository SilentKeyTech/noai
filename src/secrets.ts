/**
 * The agent vault: secrets an AI agent can use by name without ever holding them.
 *
 * The agent writes a placeholder such as {{secret:github_token}} into a request.
 * Only src/gate.ts swaps in the real value, at the moment the request leaves,
 * and only for a host and a part of the request the owner allowed when they
 * added the secret. Whatever comes back is scrubbed of every secret before the
 * agent sees it.
 *
 * Secrets live in the same vault.json as the notes, sealed under the same master
 * key. The name, the allowed hosts, the file name and the value are all inside
 * the seal; the file shows only that a secret exists and when it was added.
 *
 * This file never touches the network.
 */
import { newId, open as unseal, scrub, seal } from './crypto.ts';
import type { Placement, SealedSecret } from './types.ts';
import { type OpenVault, writeVault } from './vault.ts';

export type SecretKind = 'text' | 'file';

/** Everything about a secret except its value. Safe to show an agent. */
export interface SecretMeta {
  id: string;
  name: string;
  kind: SecretKind;
  /** original file name, for a file secret such as upload-keystore.jks */
  fileName?: string;
  bytes: number;
  /** exact hosts the value may be sent to, e.g. api.github.com or localhost:8443 */
  hosts: string[];
  /** where in a request the value may go. Header only unless the owner said otherwise. */
  placements: Placement[];
  addedAt: string;
}

export interface NewSecret {
  name: string;
  value: Buffer;
  kind?: SecretKind;
  fileName?: string;
  hosts: string[];
  placements?: Placement[];
}

/** A keystore or a service-account key is a few KB. Anything near this is not a credential. */
export const MAX_SECRET_BYTES = 256 * 1024;
/** Shorter than this, redacting every copy in a response would blank ordinary words. */
export const MIN_SECRET_BYTES = 6;

const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const PLACEMENTS: readonly Placement[] = ['header', 'url', 'body'];

/** {{secret:name}} inserts the value as text. {{secret:name:base64}} inserts it base64 encoded, which a file needs. */
export const PLACEHOLDER = /\{\{secret:([a-z0-9][a-z0-9_.-]{0,63})(?::(base64))?\}\}/g;

export function placeholderFor(name: string, encoding?: 'base64'): string {
  return `{{secret:${name}${encoding ? `:${encoding}` : ''}}}`;
}

export function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a usable secret name. Use lower case letters, digits, dot, dash or underscore, starting with a letter or digit.`);
  return name;
}

/** Hosts are compared exactly, lower case, port included when it is not 443. No wildcards. */
export function checkHost(host: string): string {
  const h = host.trim().toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(`https://${h}`);
  } catch {
    throw new Error(`"${host}" is not a host name.`);
  }
  if (parsed.host !== h || parsed.pathname !== '/' || h.includes('*')) throw new Error(`"${host}" must be a bare host such as api.github.com, with no scheme, path or wildcard.`);
  return h;
}

interface SealedBody {
  name: string;
  kind: SecretKind;
  fileName?: string;
  hosts: string[];
  placements: Placement[];
  value: string;
}

const aad = (id: string): Buffer => Buffer.from(`noai.secret:${id}`, 'utf8');

function unsealBody(v: OpenVault, s: SealedSecret): SealedBody {
  return JSON.parse(unseal(v.masterKey, s.sealed, aad(s.id)).toString('utf8')) as SealedBody;
}

function metaOf(s: SealedSecret, b: SealedBody): SecretMeta {
  return {
    id: s.id,
    name: b.name,
    kind: b.kind,
    ...(b.fileName ? { fileName: b.fileName } : {}),
    bytes: Buffer.from(b.value, 'base64').length,
    hosts: b.hosts,
    placements: b.placements,
    addedAt: s.addedAt,
  };
}

function findRecord(v: OpenVault, name: string): { record: SealedSecret; body: SealedBody } | null {
  for (const record of Object.values(v.data.secrets ?? {})) {
    const body = unsealBody(v, record);
    if (body.name === name) return { record, body };
  }
  return null;
}

/** Seal a secret into the vault. Refuses to overwrite one of the same name unless asked. */
export async function addSecret(v: OpenVault, s: NewSecret, opts: { replace?: boolean } = {}): Promise<SecretMeta> {
  const name = checkName(s.name);
  const kind = s.kind ?? 'text';
  if (s.value.length < MIN_SECRET_BYTES) throw new Error(`A secret must be at least ${String(MIN_SECRET_BYTES)} bytes.`);
  if (s.value.length > MAX_SECRET_BYTES) throw new Error(`A secret must be at most ${String(MAX_SECRET_BYTES / 1024)} KB.`);
  if (kind === 'text' && !isPlainText(s.value)) throw new Error('That value is not plain text on one line. Add it as a file instead.');
  const hosts = [...new Set(s.hosts.map(checkHost))];
  if (!hosts.length) throw new Error('Name at least one host the secret may be sent to. A secret with no host can never be used.');
  const placements = [...new Set(s.placements?.length ? s.placements : (['header'] as Placement[]))];
  for (const p of placements) if (!PLACEMENTS.includes(p)) throw new Error(`"${p}" is not a place in a request. Use header, url or body.`);

  const existing = findRecord(v, name);
  if (existing && !opts.replace) throw new Error(`A secret named ${name} is already in the vault. Remove it first, or replace it deliberately.`);
  if (existing) delete v.data.secrets?.[existing.record.id];

  const id = newId();
  const body: SealedBody = { name, kind, ...(s.fileName ? { fileName: s.fileName } : {}), hosts, placements, value: s.value.toString('base64') };
  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  const record: SealedSecret = { id, sealed: seal(v.masterKey, plain, aad(id)), addedAt: new Date().toISOString() };
  scrub(plain);
  v.data.secrets = { ...(v.data.secrets ?? {}), [id]: record };
  await writeVault(v);
  return metaOf(record, body);
}

export function listSecrets(v: OpenVault): SecretMeta[] {
  return Object.values(v.data.secrets ?? {})
    .map((r) => metaOf(r, unsealBody(v, r)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findSecret(v: OpenVault, name: string): SecretMeta | null {
  const f = findRecord(v, name);
  return f ? metaOf(f.record, f.body) : null;
}

/** Removing is a real delete of the sealed entry, not a flag. */
export async function removeSecret(v: OpenVault, name: string): Promise<boolean> {
  const f = findRecord(v, name);
  if (!f) return false;
  delete v.data.secrets?.[f.record.id];
  await writeVault(v);
  return true;
}

/**
 * The real value. Only two callers are allowed: the gate, at the moment a
 * request leaves, and the owner's own export command. Scrub the buffer after use.
 */
export function revealSecret(v: OpenVault, name: string): Buffer | null {
  const f = findRecord(v, name);
  return f ? Buffer.from(f.body.value, 'base64') : null;
}

/** Every secret value in the vault, for scrubbing responses. Scrub the buffers after use. */
export function allSecretValues(v: OpenVault): { name: string; value: Buffer }[] {
  return Object.values(v.data.secrets ?? {}).map((r) => {
    const b = unsealBody(v, r);
    return { name: b.name, value: Buffer.from(b.value, 'base64') };
  });
}

function isPlainText(b: Buffer): boolean {
  const s = b.toString('utf8');
  return Buffer.from(s, 'utf8').equals(b) && !/[\r\n\0]/.test(s);
}

/**
 * The forms a secret most often comes back in: as itself, base64 (standard and
 * URL-safe, as an API echoing a header or a Basic credential would show it),
 * URL-encoded, and hex. Each is replaced with the placeholder, so the agent can
 * see that a secret was echoed and which one.
 *
 * Honest limit: a secret that comes back transformed some other way (split,
 * re-encoded, base64 of it joined with other text) is not caught. The defence
 * against that is the host and placement policy, not this scrub.
 */
export function redactSecrets(text: string, secrets: { name: string; value: Buffer }[]): { text: string; count: number } {
  const forms: { form: string; name: string }[] = [];
  for (const s of secrets) {
    const asText = s.value.toString('utf8');
    const b64 = s.value.toString('base64');
    const variants = [b64, b64.replace(/=+$/, ''), s.value.toString('base64url'), s.value.toString('hex'), s.value.toString('hex').toUpperCase()];
    if (Buffer.from(asText, 'utf8').equals(s.value)) variants.push(asText, encodeURIComponent(asText));
    for (const f of new Set(variants)) if (f.length >= MIN_SECRET_BYTES) forms.push({ form: f, name: s.name });
  }
  // Longest first, so a form that contains another is replaced whole.
  forms.sort((a, b) => b.form.length - a.form.length);
  let out = text;
  let count = 0;
  for (const { form, name } of forms) {
    const parts = out.split(form);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(placeholderFor(name));
    }
  }
  return { text: out, count };
}

/**
 * The bearer token the local MCP server checks. Made once, sealed in the vault,
 * so starting the server again does not mean reconfiguring the agent.
 */
export async function mcpToken(v: OpenVault, opts: { rotate?: boolean } = {}): Promise<string> {
  const aadToken = Buffer.from('noai.mcp-token', 'utf8');
  if (v.data.mcpToken && !opts.rotate) return unseal(v.masterKey, v.data.mcpToken, aadToken).toString('utf8');
  const token = `noai_${newId()}${newId()}${newId()}`;
  v.data.mcpToken = seal(v.masterKey, Buffer.from(token, 'utf8'), aadToken);
  await writeVault(v);
  return token;
}

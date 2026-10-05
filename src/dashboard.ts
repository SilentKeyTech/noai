/**
 * The NOAI app's dashboard, as plain request handlers. The window the owner
 * sees (dashboard/) calls these through src/mcp-serve.ts, which carries them
 * over HTTP on 127.0.0.1 next to the MCP endpoint the agents use.
 *
 * What the dashboard can do: make or unlock the vault, add a key (text or a
 * small file such as an Android keystore), list keys, remove a key, show and
 * check the receipts, and give the line that connects Claude Code. What it can
 * never do: show a key's value. No handler here returns one, and a test holds
 * every response to that.
 *
 * This file never touches the network.
 */
import { existsSync } from 'node:fs';
import { readLedger, readReceipts, signersOf, verifyLedger } from './ledger.ts';
import { addSecret, listSecrets, mcpToken, placeholderFor, PLACEMENTS, reloadSecrets, removeSecret } from './secrets.ts';
import type { Placement, SignedReceipt, SignedSecretUse } from './types.ts';
import { closeVault, createVault, openVault, type OpenVault, signerFingerprint, vaultPathFor } from './vault.ts';

export interface AppState {
  root: string;
  /** null while locked */
  vault: OpenVault | null;
  /** the address the MCP endpoint is served on, for the connect line */
  mcpUrl: string;
}

export interface ApiReply {
  status: number;
  json: unknown;
}

const ok = (json: unknown): ApiReply => ({ status: 200, json });
const no = (status: number, error: string): ApiReply => ({ status, json: { error } });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A passphrase short enough to guess is refused when the vault is made. */
export const MIN_PASSPHRASE = 8;

function status(s: AppState) {
  const exists = existsSync(vaultPathFor(s.root));
  if (!s.vault) return { exists, unlocked: false };
  reloadSecrets(s.vault);
  return { exists, unlocked: true, keys: listSecrets(s.vault).length, deviceKey: signerFingerprint(s.vault.data.device.publicKey), mcpUrl: s.mcpUrl };
}

async function receipts(s: AppState) {
  const all = await readReceipts<SignedReceipt>(s.root);
  const verdict = verifyLedger(await readLedger(s.root), all);
  const uses = all.filter((r): r is SignedSecretUse => r.receipt.kind === 'noai.secret-use');
  return {
    valid: verdict.valid,
    reason: verdict.reason,
    total: verdict.length,
    signers: signersOf(all),
    uses: uses
      .slice(-200)
      .reverse()
      .map(({ receipt: r }) => ({
        at: r.at,
        agent: r.client,
        keys: r.secrets.map((x) => x.name),
        local: r.method === 'RUN',
        method: r.method,
        host: r.host,
        path: r.path,
        outcome: r.outcome,
        status: r.status,
        reason: r.reason ?? null,
        echoesBlanked: r.echoesRedacted,
      })),
  };
}

/**
 * One dashboard call. `path` is under /api, e.g. "/secrets". Bodies are parsed
 * JSON. Errors come back as words the owner can act on, never as a stack.
 */
export async function handleApi(s: AppState, method: string, path: string, body: unknown): Promise<ApiReply> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  try {
    if (method === 'GET' && path === '/status') return ok(status(s));

    if (method === 'POST' && path === '/create') {
      if (existsSync(vaultPathFor(s.root))) return no(409, 'There is already a vault on this PC. Unlock it instead.');
      const p = str(b.passphrase);
      if (p.length < MIN_PASSPHRASE) return no(400, `Choose a passphrase of at least ${String(MIN_PASSPHRASE)} characters.`);
      s.vault = await createVault(s.root, p);
      return ok(status(s));
    }

    if (method === 'POST' && path === '/unlock') {
      if (s.vault) return ok(status(s));
      try {
        s.vault = await openVault(s.root, str(b.passphrase));
      } catch (e) {
        return no(401, e instanceof Error && /does not open/.test(e.message) ? 'That passphrase does not open this vault.' : 'The vault could not be opened.');
      }
      return ok(status(s));
    }

    if (method === 'POST' && path === '/lock') {
      if (s.vault) closeVault(s.vault);
      s.vault = null;
      return ok(status(s));
    }

    // Everything below needs the vault open.
    const v = s.vault;
    if (!v) return no(423, 'NOAI is locked. Unlock it first.');

    if (method === 'GET' && path === '/secrets') {
      reloadSecrets(v);
      return ok({
        keys: listSecrets(v).map((m) => ({
          name: m.name,
          placeholder: placeholderFor(m.name, m.kind === 'file' ? 'base64' : undefined),
          kind: m.kind,
          fileName: m.fileName ?? null,
          bytes: m.bytes,
          sites: m.hosts,
          where: m.placements,
          addedAt: m.addedAt,
        })),
      });
    }

    if (method === 'POST' && path === '/secrets') {
      const file = str(b.fileBase64);
      const value = file ? Buffer.from(file, 'base64') : Buffer.from(str(b.value), 'utf8');
      const sites = (Array.isArray(b.sites) ? b.sites : str(b.sites).split(/[\s,]+/)).map(String).map((x) => x.trim()).filter(Boolean);
      const where = (Array.isArray(b.where) ? b.where.map(String) : []).filter((p): p is Placement => (PLACEMENTS as readonly string[]).includes(p));
      try {
        const m = await addSecret(
          v,
          {
            name: str(b.name).trim().toLowerCase(),
            value,
            kind: file ? 'file' : 'text',
            ...(file && str(b.fileName) ? { fileName: str(b.fileName).slice(0, 120) } : {}),
            hosts: sites,
            ...(where.length ? { placements: where } : file ? { placements: ['body'] as Placement[] } : {}),
          },
          { replace: b.replace === true },
        );
        return ok({ added: m.name, placeholder: placeholderFor(m.name, m.kind === 'file' ? 'base64' : undefined) });
      } finally {
        value.fill(0);
      }
    }

    if (method === 'DELETE' && path.startsWith('/secrets/')) {
      const name = decodeURIComponent(path.slice('/secrets/'.length));
      return (await removeSecret(v, name)) ? ok({ removed: name }) : no(404, `There is no key named ${name}.`);
    }

    if (method === 'GET' && path === '/receipts') return ok(await receipts(s));

    if (method === 'GET' && path === '/connect') {
      const token = await mcpToken(v);
      return ok({
        url: s.mcpUrl,
        command: `claude mcp add --transport http noai-vault ${s.mcpUrl} --header "Authorization: Bearer ${token}"`,
      });
    }

    return no(404, 'No such action.');
  } catch (e) {
    // addSecret and friends explain themselves in plain words; pass those on.
    return no(400, e instanceof Error ? e.message : String(e));
  }
}

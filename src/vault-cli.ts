/**
 * The agent vault, from the owner's own terminal.
 *
 *   npm run vault -- init
 *   npm run vault -- add <name> --host <host> [--host <host>...] [--in header,url,body] [--file <path>] [--replace]
 *   npm run vault -- list
 *   npm run vault -- remove <name>
 *   npm run vault -- export <name> <path>
 *   npm run vault -- receipts [--last <n>]
 *   npm run vault -- verify [--dir <folder>] [--expect <fingerprint>]
 *   npm run vault -- serve [--port <n>]
 *   npm run vault -- run [--env VAR=secret]... [--file VAR=secret]... -- <command> [args...]
 *   npm run vault -- token [--rotate]
 *
 * The passphrase comes from NOAI_PASSPHRASE, or is asked for without echoing.
 * A text secret is typed without echoing, or piped in. It is never taken from
 * the command line, where it would land in the shell's history.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { configFromEnv, runWithSecrets } from './gate.ts';
import { noaiHome } from './home.ts';
import { readLedger, readReceipts, signersOf, verifyLedger } from './ledger.ts';
import { createMcpServer } from './mcp-serve.ts';
import { addSecret, listSecrets, mcpToken, placeholderFor, removeSecret, revealSecret } from './secrets.ts';
import type { Placement, SignedReceipt, SignedSecretUse } from './types.ts';
import { closeVault, createVault, openVault, type OpenVault, signerFingerprint, vaultPathFor } from './vault.ts';
import { scrub } from './crypto.ts';

const [cmd, ...rest] = process.argv.slice(2);
const root = noaiHome();

/** --flag value pairs, repeatable, plus the plain words in order. */
function parse(args: string[]): { words: string[]; flags: Map<string, string[]> } {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('--')) {
      words.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { words, flags };
}

const ENTER = [13, 10].map((c) => String.fromCharCode(c));
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = [8, 127].map((c) => String.fromCharCode(c));

/** Read one line from the keyboard without showing it, or one line from a pipe. */
async function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const parts: Buffer[] = [];
    for await (const c of stdin) parts.push(c as Buffer);
    return Buffer.concat(parts).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((done, fail) => {
    let typed = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ENTER.includes(ch)) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          done(typed);
          return;
        }
        if (ch === CTRL_C) {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          fail(new Error('Cancelled. Nothing was changed.'));
          return;
        }
        if (BACKSPACE.includes(ch)) typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function passphrase(): Promise<string> {
  const p = process.env.NOAI_PASSPHRASE ?? (await askHidden('Vault passphrase: '));
  if (!p) throw new Error('No passphrase given.');
  return p;
}

async function unlock(): Promise<OpenVault> {
  if (!existsSync(vaultPathFor(root))) throw new Error(`No vault at ${vaultPathFor(root)}. Make one with: npm run vault -- init`);
  return openVault(root, await passphrase());
}

function placementsOf(flags: Map<string, string[]>): { placements?: Placement[] } {
  const given = (flags.get('in') ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  return given.length ? { placements: given as Placement[] } : {};
}

const isSecretUse = (r: SignedReceipt): r is SignedSecretUse => r.receipt.kind === 'noai.secret-use';

async function main(): Promise<void> {
  const { words, flags } = parse(rest);
  switch (cmd) {
    case 'init': {
      if (existsSync(vaultPathFor(root))) {
        const v = await unlock();
        console.log(`The vault at ${v.path} is already there and opens with that passphrase.`);
        console.log(`Device key ${signerFingerprint(v.data.device.publicKey)}. Every receipt is signed with it.`);
        closeVault(v);
        return;
      }
      const p = await passphrase();
      if (!process.env.NOAI_PASSPHRASE && process.stdin.isTTY && (await askHidden('Same passphrase again: ')) !== p) throw new Error('The two passphrases differ. Nothing was made.');
      const v = await createVault(root, p);
      console.log(`Vault made at ${v.path}. Nothing about it left this machine.`);
      console.log(`Device key ${signerFingerprint(v.data.device.publicKey)}. Write this down: verify checks receipts against it.`);
      closeVault(v);
      return;
    }
    case 'add': {
      const [name] = words;
      const hosts = flags.get('host') ?? [];
      if (!name || !hosts.length) throw new Error('Usage: npm run vault -- add <name> --host <host> [--host <host>...] [--in header,url,body] [--file <path>] [--replace]');
      const file = flags.get('file')?.[0];
      const v = await unlock();
      const value = file ? await readFile(file) : Buffer.from(await askHidden(`Value for ${name} (not shown): `), 'utf8');
      try {
        const m = await addSecret(
          v,
          { name, value, kind: file ? 'file' : 'text', ...(file ? { fileName: basename(file) } : {}), hosts, ...placementsOf(flags) },
          { replace: flags.has('replace') },
        );
        console.log(`Sealed ${m.name} (${m.kind}, ${String(m.bytes)} bytes). An agent uses it as ${placeholderFor(m.name, m.kind === 'file' ? 'base64' : undefined)}`);
        console.log(`It may be sent only to ${m.hosts.join(', ')}, only in the request ${m.placements.join(', ')}.`);
        if (file) console.log(`The vault now holds its own sealed copy. You can delete ${file} once you have checked the copy with export.`);
      } finally {
        scrub(value);
        closeVault(v);
      }
      return;
    }
    case 'list': {
      const v = await unlock();
      const all = listSecrets(v);
      if (!all.length) console.log('No secrets yet. Add one with: npm run vault -- add <name> --host <host>');
      for (const s of all) {
        console.log(`${placeholderFor(s.name, s.kind === 'file' ? 'base64' : undefined)}  ${s.kind}${s.fileName ? ` (${s.fileName})` : ''}, ${String(s.bytes)} bytes, to ${s.hosts.join(', ')}, in ${s.placements.join(', ')}, added ${s.addedAt.slice(0, 10)}`);
      }
      closeVault(v);
      return;
    }
    case 'remove': {
      const [name] = words;
      if (!name) throw new Error('Usage: npm run vault -- remove <name>');
      const v = await unlock();
      console.log((await removeSecret(v, name)) ? `Removed ${name}. Its sealed entry is gone from the vault file.` : `There is no secret named ${name}.`);
      closeVault(v);
      return;
    }
    case 'export': {
      const [name, out] = words;
      if (!name || !out) throw new Error('Usage: npm run vault -- export <name> <path>');
      if (existsSync(out)) throw new Error(`${out} already exists. Nothing was written.`);
      const v = await unlock();
      const value = revealSecret(v, name);
      closeVault(v);
      if (!value) throw new Error(`There is no secret named ${name}.`);
      await writeFile(out, value, { mode: 0o600, flag: 'wx' });
      scrub(value);
      console.log(`Wrote ${name} to ${resolve(out)}. That copy is not sealed; delete it when you are done.`);
      return;
    }
    case 'receipts': {
      const last = Math.max(1, Number(flags.get('last')?.[0] ?? 20) || 20);
      const uses = (await readReceipts<SignedReceipt>(root)).filter(isSecretUse).slice(-last);
      if (!uses.length) console.log('No secret has been used yet.');
      for (const { receipt: r } of uses) {
        const what = r.secrets.map((s) => s.name).join(', ');
        const local = r.method === 'RUN';
        const result = r.outcome === 'sent' ? (local ? `exit code ${String(r.status)}` : `sent, HTTP ${String(r.status)}`) : `${r.outcome.toUpperCase()}: ${r.reason ?? ''}`;
        const echoes = r.echoesRedacted ? `, ${String(r.echoesRedacted)} echo(es) blanked` : '';
        const where = local ? `ran ${r.path} on this PC` : `${r.method} ${r.host}${r.path}`;
        console.log(`${r.at.slice(0, 19).replace('T', ' ')}  ${r.client}  ${what}  ${where}  ${result}${echoes}`);
      }
      return;
    }
    case 'verify': {
      // Needs only the two log files. No vault, no passphrase, no network.
      const dir = flags.get('dir')?.[0] ?? root;
      if (!existsSync(join(dir, 'ledger.jsonl'))) {
        console.log(`Nothing to verify yet: no secret has been used and nothing has been disclosed from ${dir}.`);
        return;
      }
      const receipts = await readReceipts<SignedReceipt>(dir);
      const verdict = verifyLedger(await readLedger(dir), receipts);
      const signers = signersOf(receipts);
      const uses = receipts.filter(isSecretUse);
      console.log(`${verdict.valid ? 'VALID' : 'BROKEN'}: ${verdict.reason}`);
      console.log(`${String(uses.length)} of them are secret uses: ${String(uses.filter((u) => u.receipt.outcome === 'sent').length)} sent, ${String(uses.filter((u) => u.receipt.outcome === 'refused').length)} refused, ${String(uses.filter((u) => u.receipt.outcome === 'error').length)} failed.`);
      console.log(`Signed by ${signers.length ? signers.join(', ') : 'nobody yet'}.`);
      const expect = flags.get('expect')?.[0];
      let ok = verdict.valid;
      if (expect) {
        const match = signers.length > 0 && signers.every((s) => s === expect);
        console.log(match ? `Every receipt is signed by the expected key ${expect}.` : `NOT signed only by ${expect}. Someone else's key signed some or all of these.`);
        ok = ok && match;
      }
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'run': {
      // npm run vault -- run --env STORE_PASSWORD=keystore_password --file KEYSTORE=play_upload_keystore -- gradlew.bat bundleRelease
      const cut = rest.indexOf('--');
      const own = parse(cut === -1 ? rest : rest.slice(0, cut));
      const [command, ...args] = cut === -1 ? [] : rest.slice(cut + 1);
      if (!command) throw new Error('Usage: npm run vault -- run [--env VAR=secret]... [--file VAR=secret]... -- <command> [args...]');
      const pairs = (key: string) =>
        Object.fromEntries(
          (own.flags.get(key) ?? []).map((p) => {
            const at = p.indexOf('=');
            if (at < 1) throw new Error(`--${key} wants VAR=secret_name, not "${p}".`);
            return [p.slice(0, at), p.slice(at + 1)];
          }),
        );
      const v = await unlock();
      // Ctrl+C reaches the tool too. Wait for it to stop so the temporary files are wiped.
      process.on('SIGINT', () => undefined);
      try {
        const r = await runWithSecrets(v, root, { command, args, env: pairs('env'), files: pairs('file'), cwd: process.cwd() });
        if (r.outcome !== 'sent') console.error(`${r.outcome === 'refused' ? 'Refused' : 'Failed'}: ${r.reason ?? ''}`);
        console.error(`Receipt #${String(r.seq)}. ${r.tempDir ? 'The temporary key files were wiped.' : ''}`.trim());
        process.exitCode = r.outcome === 'sent' ? (r.code ?? 1) : 1;
      } finally {
        closeVault(v);
      }
      return;
    }
    case 'token': {
      const v = await unlock();
      console.log(await mcpToken(v, { rotate: flags.has('rotate') }));
      closeVault(v);
      return;
    }
    case 'serve': {
      const v = await unlock();
      const token = process.env.NOAI_MCP_TOKEN ?? (await mcpToken(v));
      if (token.length < 24) throw new Error('NOAI_MCP_TOKEN must be at least 24 characters.');
      const port = Number(flags.get('port')?.[0] ?? process.env.NOAI_MCP_PORT ?? 7792);
      // Loopback only. A coding agent on this machine is the client; nothing else needs to reach it.
      const server = createMcpServer({ ctx: { vault: v, cfg: configFromEnv(root), reveal: [], toolset: 'vault' }, token, allowedOrigins: [] });
      server.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${String(port)}/mcp`;
        console.log(`NOAI agent vault on ${url}, ${String(listSecrets(v).length)} secret(s), receipts in ${root}`);
        console.log('Connect Claude Code once, from any terminal:');
        console.log(`  claude mcp add --transport http noai-vault ${url} --header "Authorization: Bearer ${token}"`);
        console.log('Leave this window open while the agent works. Ctrl+C locks the vault again.');
      });
      process.on('SIGINT', () => {
        closeVault(v);
        server.close();
        process.exit(0);
      });
      return;
    }
    default:
      console.log('npm run vault -- init | add <name> --host <host> [--in header,url,body] [--file <path>] | list | remove <name> | export <name> <path> | receipts | verify | run --env VAR=name --file VAR=name -- <command> | serve | token');
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

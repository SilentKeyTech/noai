/**
 * Both command lines under bad arguments. Every command in src/cli.ts and
 * src/vault-cli.ts is run as a child process in its own temporary home, with
 * nothing from the real environment. A bad call must exit non-zero with a
 * usage or error line on stderr, print no stack trace, and create no file.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const script = (name: string): string => new URL(`../src/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CLI = script('cli.ts');
const VAULT = script('vault-cli.ts');
const PASS = 'a passphrase used only by this test';
// Each run starts Node and may run scrypt once.
const SLOW = { timeout: 120_000 };

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

interface Home {
  /** HOME and the working directory of the child */
  home: string;
  /** NOAI_HOME, where a vault would go. Does not exist until a command makes it. */
  data: string;
}

async function freshHome(): Promise<Home> {
  const home = await mkdtemp(join(tmpdir(), 'noai-cli-'));
  dirs.push(home);
  return { home, data: join(home, 'data') };
}

/** Every path under a folder, so "nothing was created" is one deepEqual. */
async function tree(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one command in a child process that sees only the temporary home. */
function run(file: string, args: string[], h: Home, env: Record<string, string> = {}): Promise<Run> {
  const base: Record<string, string> = { HOME: h.home, NOAI_HOME: h.data, NOAI_MODEL_DIR: join(h.home, 'no-model') };
  for (const k of ['PATH', 'SYSTEMROOT', 'SystemRoot']) if (process.env[k]) base[k] = process.env[k]!;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: h.home, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    // 'close' and not 'exit': the pipes may still hold output when 'exit' fires.
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const STACK = /^\s+at .+:\d+:\d+\)?$/m;

/** A refused call: non-zero, a message on stderr only, no stack, nothing new on disk. */
function refused(r: Run, before: string[], after_: string[], pattern: RegExp, what: string): void {
  assert.notEqual(r.code, 0, `${what}: exited 0\n${r.stdout}`);
  assert.match(r.stderr, pattern, `${what}: stderr was ${JSON.stringify(r.stderr)}`);
  assert.ok(!STACK.test(r.stderr), `${what}: a stack trace reached the user\n${r.stderr}`);
  assert.ok(!r.stderr.includes('node:internal'), `${what}: Node internals reached the user\n${r.stderr}`);
  assert.equal(r.stdout, '', `${what}: wrote to stdout`);
  assert.deepEqual(after_, before, `${what}: changed the home folder`);
}

async function expectRefused(file: string, args: string[], h: Home, pattern: RegExp, env: Record<string, string> = {}): Promise<Run> {
  const before = await tree(h.home);
  const r = await run(file, args, h, env);
  refused(r, before, await tree(h.home), pattern, `${file === CLI ? 'noai' : 'vault'} ${args.join(' ')}`);
  return r;
}

async function withVault(): Promise<Home> {
  const h = await freshHome();
  const r = await run(CLI, ['init'], h, { NOAI_PASSPHRASE: PASS });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(h.data, 'vault.json')));
  return h;
}

describe('noai with bad arguments', () => {
  it('no command, or an unknown one: usage on stderr, exit 1, nothing made', SLOW, async () => {
    const h = await freshHome();
    await expectRefused(CLI, [], h, /^noai init \| seed \| add/);
    await expectRefused(CLI, ['bogus'], h, /^noai init \| seed \| add/);
    await expectRefused(CLI, ['--help'], h, /^noai init/);
  });

  it('a command missing its argument says how to call it', SLOW, async () => {
    const h = await freshHome();
    await expectRefused(CLI, ['add'], h, /^Usage: noai add <title> <text>/);
    await expectRefused(CLI, ['add', 'title only'], h, /^Usage: noai add/);
    await expectRefused(CLI, ['import'], h, /^Usage: noai import <file/);
    await expectRefused(CLI, ['remember'], h, /^Usage: noai remember/);
    await expectRefused(CLI, ['ask'], h, /^Usage: noai ask/);
  });

  it('every command that needs the vault says there is none, and makes none', SLOW, async () => {
    const h = await freshHome();
    for (const args of [['seed'], ['add', 'title', 'text'], ['import', 'notes.txt'], ['remember', 'a fact'], ['people'], ['ask', 'a question']]) {
      await expectRefused(CLI, args, h, /^No vault at .*vault\.json\. Run "noai init" first\./, { NOAI_PASSPHRASE: PASS });
    }
    assert.ok(!existsSync(h.data));
  });

  it('a vault home that cannot exist is reported, not created', SLOW, async () => {
    const h = await freshHome();
    const nowhere = join(h.home, 'no', 'such', 'place');
    const r = await run(CLI, ['people'], h, { NOAI_PASSPHRASE: PASS, NOAI_HOME: nowhere });
    refused(r, [], await tree(nowhere), /^No vault at /, 'noai people with a missing home');
  });

  it('init without a passphrase refuses and writes nothing; init twice refuses and keeps the first vault', SLOW, async () => {
    const h = await freshHome();
    await expectRefused(CLI, ['init'], h, /^Set NOAI_PASSPHRASE/);
    const made = await run(CLI, ['init'], h, { NOAI_PASSPHRASE: PASS });
    assert.equal(made.code, 0, made.stderr);
    await expectRefused(CLI, ['init'], h, /^A vault already exists at/, { NOAI_PASSPHRASE: PASS });
  });

  it('a wrong passphrase is refused the same way for every command', SLOW, async () => {
    const h = await withVault();
    for (const args of [['people'], ['add', 'title', 'text'], ['ask', 'a question'], ['remember', 'a fact']]) {
      await expectRefused(CLI, args, h, /^That passphrase does not open this vault\./, { NOAI_PASSPHRASE: 'not the passphrase' });
    }
  });

  it('a file that is not there, and a port that is not a number, are refused without a stack', SLOW, async () => {
    const h = await withVault();
    await expectRefused(CLI, ['import', join(h.home, 'missing.txt')], h, /no such file/, { NOAI_PASSPHRASE: PASS });
    await expectRefused(CLI, ['serve'], h, /port/, { NOAI_PORT: 'abc' });
  });

  it('ask without an API key sends nothing and leaves no ledger', SLOW, async () => {
    const h = await withVault();
    await expectRefused(CLI, ['ask', 'when is the rent due?'], h, /NEBIUS_API_KEY is not set\. Nothing was sent\./, { NOAI_PASSPHRASE: PASS });
    assert.ok(!existsSync(join(h.data, 'ledger.jsonl')));
  });

  it('tape and verify on an empty home answer plainly; a broken ledger is an error, not a crash', SLOW, async () => {
    const h = await withVault();
    const tape = await run(CLI, ['tape'], h);
    assert.deepEqual([tape.code, tape.stdout, tape.stderr], [0, '', '']);
    const verify = await run(CLI, ['verify'], h);
    assert.equal(verify.code, 0, verify.stderr);
    assert.match(verify.stdout, /^VALID/);
    await writeFile(join(h.data, 'ledger.jsonl'), 'this is not a ledger\n');
    const before = await tree(h.home);
    const broken = await run(CLI, ['verify'], h);
    assert.notEqual(broken.code, 0, 'a broken ledger verified');
    // Two shapes are right: a parse error on stderr, or the ledger reader keeping the damaged line and verify reporting BROKEN on stdout.
    assert.ok(/JSON/.test(broken.stderr) || broken.stdout.startsWith('BROKEN: Entry 0 cannot be read'), `stdout ${JSON.stringify(broken.stdout)} stderr ${JSON.stringify(broken.stderr)}`);
    for (const out of [broken.stdout, broken.stderr]) assert.ok(!STACK.test(out) && !out.includes('node:internal'), `a stack trace reached the user\n${out}`);
    assert.deepEqual(await tree(h.home), before, 'verify changed the home folder');
  });
});

describe('vault with bad arguments', () => {
  it('no command, or an unknown one: usage on stderr, exit 1, nothing made', SLOW, async () => {
    const h = await freshHome();
    await expectRefused(VAULT, [], h, /^npm run vault -- init \| add/);
    await expectRefused(VAULT, ['bogus'], h, /^npm run vault -- init/);
    await expectRefused(VAULT, ['--host', 'x'], h, /^npm run vault -- init/);
  });

  it('a command missing its argument or flag says how to call it, before asking for a passphrase', SLOW, async () => {
    const h = await freshHome();
    await expectRefused(VAULT, ['add'], h, /^Usage: npm run vault -- add <name> --host/);
    await expectRefused(VAULT, ['add', 'github_token'], h, /^Usage: npm run vault -- add/);
    await expectRefused(VAULT, ['remove'], h, /^Usage: npm run vault -- remove/);
    await expectRefused(VAULT, ['export'], h, /^Usage: npm run vault -- export/);
    await expectRefused(VAULT, ['export', 'github_token'], h, /^Usage: npm run vault -- export/);
    await expectRefused(VAULT, ['run'], h, /^Usage: npm run vault -- run/);
    await expectRefused(VAULT, ['run', '--'], h, /^Usage: npm run vault -- run/);
    await expectRefused(VAULT, ['run', '--env', 'X=y'], h, /^Usage: npm run vault -- run/);
  });

  it('every command that needs the vault says there is none, and makes none', SLOW, async () => {
    const h = await freshHome();
    const out = join(h.home, 'out.bin');
    for (const args of [['list'], ['token'], ['serve'], ['remove', 'github_token'], ['export', 'github_token', out], ['add', 'github_token', '--host', 'api.github.com'], ['run', '--', 'echo', 'hi']]) {
      await expectRefused(VAULT, args, h, /^No vault at .*vault\.json\. Make one with: npm run vault -- init/, { NOAI_PASSPHRASE: PASS });
    }
    assert.ok(!existsSync(h.data) && !existsSync(out));
  });

  it('init with no passphrase and no terminal refuses and writes nothing', SLOW, async () => {
    const h = await freshHome();
    await expectRefused(VAULT, ['init'], h, /^No passphrase given\./);
    assert.ok(!existsSync(h.data));
  });

  it('a wrong passphrase is refused for every command that unlocks', SLOW, async () => {
    const h = await withVault();
    for (const args of [['list'], ['token'], ['remove', 'github_token'], ['add', 'github_token', '--host', 'api.github.com']]) {
      await expectRefused(VAULT, args, h, /^That passphrase does not open this vault\./, { NOAI_PASSPHRASE: 'not the passphrase' });
    }
  });

  it('a missing file, an unknown secret, an output path that exists, a bad --env pair and a bad port are refused without a stack', SLOW, async () => {
    const h = await withVault();
    const env = { NOAI_PASSPHRASE: PASS };
    await expectRefused(VAULT, ['add', 'upload_keystore', '--host', 'signing.example.test', '--file', join(h.home, 'missing.jks')], h, /no such file/, env);
    await expectRefused(VAULT, ['export', 'github_token', join(h.home, 'out.bin')], h, /^There is no secret named github_token\./, env);
    const taken = join(h.home, 'taken.bin');
    await writeFile(taken, 'already here');
    await expectRefused(VAULT, ['export', 'github_token', taken], h, /already exists\. Nothing was written\./, env);
    await expectRefused(VAULT, ['run', '--env', 'NOEQUALS', '--', 'echo', 'hi'], h, /--env wants VAR=secret_name/, env);
    await expectRefused(VAULT, ['serve', '--port', 'abc'], h, /port/, env);
    await expectRefused(VAULT, ['app', '--port', 'abc'], h, /port/, env);
  });

  it('receipts, verify and list on an empty home answer plainly, and a bad --last or --dir falls back instead of crashing', SLOW, async () => {
    const h = await withVault();
    for (const [args, pattern] of [
      [['receipts'], /^No secret has been used yet\./],
      [['receipts', '--last', 'abc'], /^No secret has been used yet\./],
      [['verify'], /^Nothing to verify yet/],
      [['verify', '--dir', join(h.home, 'nowhere')], /^Nothing to verify yet/],
      [['list'], /^No secrets yet\./],
    ] as [string[], RegExp][]) {
      const r = await run(VAULT, args, h, { NOAI_PASSPHRASE: PASS });
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stdout, pattern);
      assert.equal(r.stderr, '');
    }
    assert.ok(!existsSync(join(h.home, 'nowhere')));
  });

  it('a data folder that is a file, not a folder, is an error and not a stack', SLOW, async () => {
    const h = await freshHome();
    const asFile = join(h.home, 'data-as-file');
    await writeFile(asFile, 'not a folder');
    const before = await tree(h.home);
    const r = await run(VAULT, ['init'], h, { NOAI_PASSPHRASE: PASS, NOAI_HOME: asFile });
    refused(r, before, await tree(h.home), /./, 'vault init with a file for a home');
  });
});

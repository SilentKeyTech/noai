/**
 * The vault file under bad conditions: a wrong passphrase, flipped bytes, a
 * truncated file, and a save that dies half way through. None of these may
 * change the file on disk, and the last good vault must still open after.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { b64, sha256, unb64 } from '../src/crypto.ts';
import type { Sealed, Vault } from '../src/types.ts';
import { addNote, createVault, openVault, readNotes, unwrapPrivateKey, vaultPathFor } from '../src/vault.ts';

process.env.NOAI_MODEL_DIR = join(tmpdir(), 'noai-no-model-here');

const PASS = 'a passphrase used only by the hardening tests';
const NOTES = ['Penicillin allergy', 'Rent is 850 USD'];
// Each open attempt runs scrypt once. A hang shows up as a timeout, not as a stuck suite.
const SLOW = { timeout: 60_000 };
const VAULT_TS = new URL('../src/vault.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'noai-hard-'));
  dirs.push(d);
  return d;
}

/** Every file under root with its hash, so "nothing changed on disk" is one deepEqual. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await readdir(root)).sort()) out[f] = sha256(await readFile(join(root, f)));
  return out;
}

/** A vault with two notes, and the file exactly as it was written. */
async function goodVault(): Promise<{ root: string; path: string; text: string }> {
  const root = await tmp();
  const v = await createVault(root, PASS);
  await addNote(v, 'Health', NOTES[0]!);
  await addNote(v, 'Money', NOTES[1]!);
  const path = vaultPathFor(root);
  return { root, path, text: await readFile(path, 'utf8') };
}

/** Open and read every note, which is what every command does first. */
async function openAndRead(root: string, pass = PASS): Promise<string[]> {
  return readNotes(await openVault(root, pass))
    .map((n) => n.body)
    .sort();
}

/** Write a damaged file, try to open it, and check that the attempt did not write anything. */
async function mustFailUntouched(root: string, damaged: string | Buffer, pattern?: RegExp): Promise<Error> {
  await writeFile(vaultPathFor(root), damaged);
  const before = await snapshot(root);
  let caught: unknown = null;
  try {
    await openAndRead(root);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, 'a damaged vault was opened as if it were fine');
  if (pattern) assert.match(caught.message, pattern);
  assert.deepEqual(await snapshot(root), before, 'the failed open changed something on disk');
  return caught;
}

/** The same sealed box with one byte of one field changed. */
function flipSealed(s: Sealed, field: keyof Sealed, at = 0): Sealed {
  const raw = unb64(s[field]);
  const i = at % raw.length;
  raw[i] = raw[i]! ^ 0x01;
  return { ...s, [field]: b64(raw) };
}

const mutate = (text: string, fn: (d: Vault) => void): string => {
  const d = JSON.parse(text) as Vault;
  fn(d);
  return `${JSON.stringify(d, null, 2)}\n`;
};

describe('a wrong passphrase', () => {
  it('is refused with one clear error, reads nothing, and leaves the folder exactly as it was', SLOW, async () => {
    const { root, path, text } = await goodVault();
    const before = await snapshot(root);
    for (const wrong of ['', 'wrong', PASS.slice(0, -1), `${PASS} `, PASS.toUpperCase()]) {
      let message = '';
      await assert.rejects(openVault(root, wrong), (e: unknown) => {
        message = e instanceof Error ? e.message : '';
        return /does not open/.test(message);
      });
      assert.ok(!message.includes(PASS), 'the error repeats the real passphrase');
      assert.ok(wrong === '' || !message.includes(wrong), 'the error repeats the attempt');
    }
    assert.deepEqual(await readdir(root), ['vault.json']);
    assert.deepEqual(await snapshot(root), before);
    assert.equal(await readFile(path, 'utf8'), text);
    assert.deepEqual(await openAndRead(root), NOTES);
  });
});

describe('a corrupted vault file', () => {
  const flips: [string, (d: Vault) => void, RegExp][] = [
    ['a note ciphertext', (d) => void (Object.values(d.notes)[0]!.sealed = flipSealed(Object.values(d.notes)[0]!.sealed, 'ct', 3)), /unable to authenticate/],
    ['a note auth tag', (d) => void (Object.values(d.notes)[1]!.sealed = flipSealed(Object.values(d.notes)[1]!.sealed, 'tag', 15)), /unable to authenticate/],
    ['a note iv', (d) => void (Object.values(d.notes)[0]!.sealed = flipSealed(Object.values(d.notes)[0]!.sealed, 'iv')), /unable to authenticate/],
    ['the master key ciphertext', (d) => void (d.masterKey = flipSealed(d.masterKey, 'ct', 7)), /does not open/],
    ['the master key auth tag', (d) => void (d.masterKey = flipSealed(d.masterKey, 'tag')), /does not open/],
    ['the check ciphertext', (d) => void (d.check = flipSealed(d.check, 'ct')), /does not open/],
    ['the check auth tag', (d) => void (d.check = flipSealed(d.check, 'tag', 15)), /does not open/],
    ['the KDF salt in the header', (d) => void (d.kdf.salt = b64(Buffer.from(unb64(d.kdf.salt).map((x, i) => (i === 0 ? x ^ 0x01 : x))))), /does not open/],
    ['the version in the header', (d) => void ((d as { version: number }).version = 2), /not a NOAI vault/],
    ['the product in the header', (d) => void ((d as { product: string }).product = 'other'), /not a NOAI vault/],
    [
      'a sealed note moved under another note id',
      (d) => {
        const [a, b] = Object.values(d.notes);
        [a!.sealed, b!.sealed] = [b!.sealed, a!.sealed];
      },
      /unable to authenticate/,
    ],
  ];
  for (const [what, fn, pattern] of flips) {
    it(`one flipped byte in ${what}: a clean error, the file untouched, the restored file still opens`, SLOW, async () => {
      const { root, path, text } = await goodVault();
      await mustFailUntouched(root, mutate(text, fn), pattern);
      await writeFile(path, text);
      assert.deepEqual(await openAndRead(root), NOTES);
    });
  }

  it('a flipped byte anywhere in the file either changes nothing readable or fails cleanly, and never rewrites the file', SLOW, async () => {
    const { root, path, text } = await goodVault();
    const bytes = Buffer.from(text, 'utf8');
    const positions = [0, 1, 2, 9, ...Array.from({ length: 9 }, (_, i) => Math.floor((bytes.length * (i + 1)) / 10)), bytes.length - 3, bytes.length - 2];
    let failed = 0;
    for (const at of positions) {
      const damaged = Buffer.from(bytes);
      damaged[at] = damaged[at]! ^ 0x01;
      await writeFile(path, damaged);
      const before = await snapshot(root);
      try {
        // A flip in a field nothing depends on (a timestamp, a byte count) is harmless: the notes read the same.
        assert.deepEqual(await openAndRead(root), NOTES);
      } catch (e) {
        assert.ok(e instanceof Error && !(e instanceof assert.AssertionError), `byte ${String(at)}: notes came back different instead of an error`);
        failed += 1;
      }
      assert.deepEqual(await snapshot(root), before, `byte ${String(at)}: the open attempt wrote to disk`);
    }
    assert.ok(failed > 0, 'no position broke anything, which means the flips did not reach the file');
    await writeFile(path, text);
    assert.deepEqual(await openAndRead(root), NOTES);
  });

  it('a truncated file fails cleanly at every cut and is not rewritten', SLOW, async () => {
    const { root, path, text } = await goodVault();
    const cuts = [0, 1, 2, 16, Math.floor(text.length / 4), Math.floor(text.length / 2), Math.floor((text.length * 3) / 4), text.length - 3];
    for (const cut of cuts) {
      const err = await mustFailUntouched(root, text.slice(0, cut));
      assert.ok(err.message.length > 0 && !err.message.includes('\n    at '), `cut at ${String(cut)}: the error carries a stack trace`);
    }
    await writeFile(path, text);
    assert.deepEqual(await openAndRead(root), NOTES);
  });

  it('a file of random bytes, or an empty file, is refused and left alone', SLOW, async () => {
    const { root, path, text } = await goodVault();
    const noise = Buffer.alloc(2048);
    let x = 0x9e3779b9;
    for (let i = 0; i < noise.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      noise[i] = (x >>> 16) & 0xff;
    }
    await mustFailUntouched(root, noise);
    await mustFailUntouched(root, '');
    await mustFailUntouched(root, '{}', /not a NOAI vault/);
    await writeFile(path, text);
    assert.deepEqual(await openAndRead(root), NOTES);
  });

  it('a damaged device key still opens and reads, and fails only when a receipt would be signed', SLOW, async () => {
    const { root, path, text } = await goodVault();
    await writeFile(path, mutate(text, (d) => void (d.device.privateKey = flipSealed(d.device.privateKey, 'ct', 5))));
    const v = await openVault(root, PASS);
    assert.deepEqual(readNotes(v).map((n) => n.body).sort(), NOTES);
    assert.throws(() => unwrapPrivateKey(v), /unable to authenticate/);
  });
});

/**
 * Run one save in a child process that dies at a chosen point. Node's own fs
 * module is patched before vault.ts loads, so the vault code runs unchanged.
 */
async function crashingSave(root: string, where: 'before-rename' | 'mid-write'): Promise<{ code: number; stderr: string }> {
  const patch =
    where === 'before-rename'
      ? 'fsp.rename = async () => process.exit(3);'
      : 'fsp.writeFile = async (path, data, opts) => { const s = String(data); await writeFile(path, s.slice(0, Math.floor(s.length / 2)), opts); process.exit(4); };';
  const script = [
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    "const fsp = require('node:fs/promises');",
    'const writeFile = fsp.writeFile;',
    patch,
    "require('node:module').syncBuiltinESMExports();",
    `const { openVault, addNote } = await import(${JSON.stringify(VAULT_TS)});`,
    `const v = await openVault(${JSON.stringify(root)}, ${JSON.stringify(PASS)});`,
    "await addNote(v, 'Car', 'Insurance renews in March');",
    'process.exit(0);',
    '',
  ].join('\n');
  const scratch = await tmp();
  const file = join(scratch, `crash-${where}.mjs`);
  await writeFile(file, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe('an interrupted save', () => {
  it('that dies after writing the new file but before the rename leaves the old vault untouched and readable', SLOW, async () => {
    const { root, path, text } = await goodVault();
    const r = await crashingSave(root, 'before-rename');
    assert.equal(r.code, 3, r.stderr);
    assert.equal(await readFile(path, 'utf8'), text, 'the vault file itself was written to');
    const leftover = (await readdir(root)).filter((f) => f !== 'vault.json');
    assert.equal(leftover.length, 1);
    assert.match(leftover[0]!, /^vault\.json\.\d+\.tmp$/);
    // The temporary file holds the complete new state: the save is all or nothing.
    const staged = JSON.parse(await readFile(join(root, leftover[0]!), 'utf8')) as Vault;
    assert.equal(Object.keys(staged.notes).length, 3);
    assert.deepEqual(await openAndRead(root), NOTES);
  });

  it('that dies half way through writing leaves the half in the temporary file, never in the vault', SLOW, async () => {
    const { root, path, text } = await goodVault();
    const r = await crashingSave(root, 'mid-write');
    assert.equal(r.code, 4, r.stderr);
    assert.equal(await readFile(path, 'utf8'), text);
    const leftover = (await readdir(root)).filter((f) => f !== 'vault.json');
    assert.equal(leftover.length, 1);
    const half = await readFile(join(root, leftover[0]!), 'utf8');
    assert.ok(half.length > 0 && half.length < text.length);
    assert.throws(() => JSON.parse(half), SyntaxError, 'the temporary file should hold an unfinished write');
    assert.deepEqual(await openAndRead(root), NOTES);
  });

  it('a stale temporary file from an earlier crash is ignored, and the next save still goes through', SLOW, async () => {
    const { root, path } = await goodVault();
    await writeFile(`${path}.99999.tmp`, '{"version": 1, "product": "noai", this is not even JSON');
    const v = await openVault(root, PASS);
    await addNote(v, 'Car', 'Insurance renews in March');
    JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(await openAndRead(root), [...NOTES, 'Insurance renews in March'].sort());
  });

  it('three saves at once from one process still leave one complete vault on disk with every note', SLOW, async () => {
    const { root, path } = await goodVault();
    const v = await openVault(root, PASS);
    // The saves share one temporary file name, so one of them may reject with ENOENT
    // on its rename. What matters here is that no note is lost and no half file remains.
    await Promise.allSettled([addNote(v, 'a', 'one'), addNote(v, 'b', 'two'), addNote(v, 'c', 'three')]);
    JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(await openAndRead(root), [...NOTES, 'one', 'three', 'two'].sort());
  });
});

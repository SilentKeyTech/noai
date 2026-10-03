/**
 * Build the NOAI Microsoft Store package (MSIX) on this PC.
 *
 *   node packaging/msix/build.ts [--version 0.5.0.0]
 *
 * Lays out packaging/msix/out/NOAI/ as the package will install:
 *   noai-vault.exe      launcher, compiled from launcher.cs by the C# compiler in Windows
 *   node/node.exe       this machine's Node, signed by the OpenJS Foundation
 *   app/src, app/node_modules, app/package.json   NOAI itself, production dependencies only
 *   assets/             icons from the NOAI logo kit
 *   AppxManifest.xml    identity of Partner Center product 9P7HDN9XV24C
 * then packs it with MakeAppx.exe if one can be found (MAKEAPPX=path, or the
 * Windows SDK or SDK BuildTools folders). Nothing is signed or uploaded here:
 * the Store signs what it accepts, and the owner decides what is submitted.
 *
 * No native npm module is added, so Smart App Control has nothing new to block.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = join(here, '..', '..');
const out = join(here, 'out');
const stage = join(out, 'NOAI');
const argv = process.argv.slice(2);
const version = argv.includes('--version') ? String(argv[argv.indexOf('--version') + 1]) : '0.5.0.0';
if (!/^\d+\.\d+\.\d+\.0$/.test(version)) throw new Error('The Store wants a version like 0.5.0.0, with the last number 0.');

const step = (s: string) => console.log(`- ${s}`);

await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'app'), { recursive: true });

// 1. NOAI itself. Only what the vault and the notes server need at run time.
step('copying NOAI source');
await cp(join(repo, 'src'), join(stage, 'app', 'src'), { recursive: true });
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as Record<string, unknown>;
await writeFile(join(stage, 'app', 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', license: pkg.license, dependencies: pkg.dependencies }, null, 2)}\n`);
await cp(join(repo, 'LICENSE'), join(stage, 'LICENSE.txt'));

step('copying production dependencies');
const prod = execSync('npm ls --omit=dev --parseable --all', { cwd: repo, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((p) => p.includes('node_modules'))
  .map((p) => p.slice(p.lastIndexOf('node_modules') + 'node_modules'.length + 1));
// @types and undici-types are type declarations only; Node strips types and never loads them.
for (const dep of [...new Set(prod)].filter((d) => !d.startsWith('@types') && d !== 'undici-types')) {
  await cp(join(repo, 'node_modules', dep), join(stage, 'app', 'node_modules', dep), { recursive: true, filter: (p) => !/\.map$/.test(p) });
}

// 2. Node, as installed and signed.
step(`copying Node ${process.version}`);
await mkdir(join(stage, 'node'), { recursive: true });
await cp(process.execPath, join(stage, 'node', 'node.exe'));
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
if (existsSync(nodeLicense)) await cp(nodeLicense, join(stage, 'node', 'LICENSE.txt'));

// 3. The launcher.
step('compiling the launcher');
const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) throw new Error(`No C# compiler at ${csc}.`);
execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${join(stage, 'noai-vault.exe')}`, join(here, 'launcher.cs')], { stdio: 'inherit' });
// The app people open: a windowed program, no console, with the tray icon.
execFileSync(csc, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', `/out:${join(stage, 'NOAI.exe')}`, join(here, 'app.cs')], { stdio: 'inherit' });
step('copying the NOAI window');
await cp(join(repo, 'dashboard'), join(stage, 'app', 'dashboard'), { recursive: true });

// 4. Manifest and icons.
step(`writing the manifest, version ${version}`);
await writeFile(join(stage, 'AppxManifest.xml'), (await readFile(join(here, 'AppxManifest.xml'), 'utf8')).replace('{{VERSION}}', version));
await cp(join(here, 'assets'), join(stage, 'assets'), { recursive: true });

// 5. Smoke test from the staged folder, with a throwaway vault: the packaged Node runs the
// packaged vault command line with only the packaged dependencies. The launcher itself
// cannot be run here: Smart App Control blocks any program nobody has signed yet, and
// the Store signs it only when it accepts the package (as it did ModeGuard's). It is
// tested from the Store install.
step('smoke test: the packaged Node runs the packaged vault command line');
const home = await mkdtemp(join(tmpdir(), 'noai-msix-smoke-'));
const run = spawnSync(join(stage, 'node', 'node.exe'), [join(stage, 'app', 'src', 'vault-cli.ts'), 'verify'], { cwd: tmpdir(), env: { ...process.env, NOAI_HOME: home, NODE_PATH: '' }, encoding: 'utf8' });
await rm(home, { recursive: true, force: true });
const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
if (run.error || run.status !== 0 || !/Nothing to verify yet/.test(said)) {
  throw new Error(`The staged launcher did not run cleanly (exit ${String(run.status)}${run.error ? `, ${run.error.message}` : ''}): ${said.slice(0, 400)}`);
}
console.log(`  ${said.split('\n')[0]}`);

// 6. Pack.
function findMakeAppx(): string | null {
  if (process.env.MAKEAPPX && existsSync(process.env.MAKEAPPX)) return process.env.MAKEAPPX;
  const roots = [join('C:\\Program Files (x86)', 'Windows Kits', '10', 'bin'), join(here, 'tools')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const hits = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /[\\/]x64[\\/]makeappx\.exe$/i.test(`\\${f}`)).sort();
    if (hits.length) return join(root, hits[hits.length - 1] as string);
  }
  return null;
}
const makeappx = findMakeAppx();

// The icons come in two sizes (scale-100, scale-200) so they stay sharp on high-DPI screens.
// Windows finds the right one through resources.pri, built by MakePri from the same SDK folder.
if (makeappx) {
  const makepri = join(dirname(makeappx), 'makepri.exe');
  if (!existsSync(makepri)) throw new Error(`No makepri.exe next to ${makeappx}.`);
  step('indexing the icons with MakePri');
  const cfg = join(out, 'priconfig.xml');
  await rm(join(stage, 'resources.pri'), { force: true });
  execFileSync(makepri, ['createconfig', '/cf', cfg, '/dq', 'en-US', '/pv', '10.0.0', '/o'], { stdio: 'ignore' });
  execFileSync(makepri, ['new', '/pr', stage, '/cf', cfg, '/mn', join(stage, 'AppxManifest.xml'), '/of', join(stage, 'resources.pri'), '/o'], { stdio: 'ignore' });
}
const msix = join(out, `NOAI_${version}_x64.msix`);
if (!makeappx) {
  console.log(`\nStaged at ${stage}. No MakeAppx.exe found, so no .msix yet. Set MAKEAPPX to its path and run again.`);
} else {
  step(`packing with ${makeappx}`);
  await rm(msix, { force: true });
  execFileSync(makeappx, ['pack', '/d', stage, '/p', msix, '/o'], { stdio: 'inherit' });
  console.log(`\nBuilt ${msix}. Unsigned: the Store signs it on acceptance. Nothing was uploaded.`);
}

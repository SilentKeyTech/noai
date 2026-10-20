/**
 * Build the browser extension into extension/lib, ready to load unpacked.
 *
 * Like build-web.ts, the redaction modules in src/ are transpiled, not
 * rewritten, so the extension hides exactly what the gateway and the tests
 * hide. extension/lib mirrors the repo layout (lib/src, lib/extension/src) so
 * relative imports work unchanged once .ts becomes .js.
 *
 *   npm run build:extension
 *   then chrome://extensions → Developer mode → Load unpacked → the extension folder
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ext = join(root, 'extension');
const lib = join(ext, 'lib');
/** the shared modules the extension needs from src/: what redact.ts imports, and nothing that touches Node */
const SHARED = ['names', 'redact'];

async function transpile(from: string, to: string): Promise<void> {
  const src = await readFile(from, 'utf8');
  if (/from\s+['"]node:/.test(src)) throw new Error(`${relative(root, from)} imports a Node built-in and cannot run in the browser.`);
  const out = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
    fileName: from,
  }).outputText.replace(/(from\s+['"]\.{1,2}\/[\w./-]+)\.ts(['"])/g, '$1.js$2');
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, `// Generated from ${relative(root, from).replaceAll('\\', '/')} by scripts/build-extension.ts. Do not edit.\n${out}`);
}

await rm(lib, { recursive: true, force: true });
for (const name of SHARED) await transpile(join(root, 'src', `${name}.ts`), join(lib, 'src', `${name}.js`));
let count = SHARED.length;
for (const f of await readdir(join(ext, 'src'), { recursive: true })) {
  if (!f.endsWith('.ts')) continue;
  await transpile(join(ext, 'src', f), join(lib, 'extension', 'src', f.replace(/\.ts$/, '.js')));
  count++;
}
console.log(`extension  ${String(count)} modules`);
console.log(`Built ${ext}`);

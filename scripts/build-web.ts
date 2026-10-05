/**
 * Build the browser version into web/app.
 *
 * The pure modules in src/ are transpiled, not rewritten, so the browser ranks,
 * redacts and prompts with the same code the desktop tests prove. Libraries are
 * vendored from node_modules and served from the same origin: a privacy product
 * does not load its cryptography from someone else's CDN.
 *
 *   npm run build:web
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { MODEL, modelDir } from '../src/embed.ts';

const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const app = join(root, 'web', 'app');
const PURE = ['names', 'redact', 'people', 'ingest', 'retrieve', 'vector', 'prompt', 'memory', 'skills', 'checkins'];

// 1. pure modules
const coreDir = join(app, 'lib', 'core');
await rm(coreDir, { recursive: true, force: true });
await mkdir(coreDir, { recursive: true });
for (const name of PURE) {
  const src = await readFile(join(root, 'src', `${name}.ts`), 'utf8');
  if (/from\s+['"]node:/.test(src)) throw new Error(`src/${name}.ts imports a Node built-in and cannot run in the browser.`);
  const out = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false, rewriteRelativeImportExtensions: true },
    fileName: `${name}.ts`,
  }).outputText.replace(/(from\s+['"]\.\/[\w-]+)\.ts(['"])/g, '$1.js$2');
  await writeFile(join(coreDir, `${name}.js`), `// Generated from src/${name}.ts by scripts/build-web.ts. Do not edit.\n${out}`);
}

// 2. vendored libraries, JavaScript only
const vendor = join(app, 'vendor');
await rm(vendor, { recursive: true, force: true });
for (const [pkg, dest] of [['@noble/hashes', 'noble-hashes'], ['@noble/curves', 'noble-curves']] as const) {
  await cp(join(root, 'node_modules', pkg), join(vendor, dest), {
    recursive: true,
    filter: (p) => !/\.(ts|map|md)$/.test(p) && !/[\\/]src[\\/]?/.test(p.slice(join(root, 'node_modules', pkg).length)),
  });
}
// noble-curves imports '@noble/hashes/x.js' by package name. Browsers cannot
// resolve that without an import map, and an inline import map would need the
// Content Security Policy loosened. Rewrite them to relative paths instead.
for (const f of await readdir(join(vendor, 'noble-curves'), { recursive: true })) {
  if (!f.endsWith('.js')) continue;
  const p = join(vendor, 'noble-curves', f);
  const depth = f.split(/[\\/]/).length - 1;
  const up = '../'.repeat(depth + 1);
  const src = await readFile(p, 'utf8');
  if (src.includes('@noble/hashes/')) await writeFile(p, src.replaceAll(`'@noble/hashes/`, `'${up}noble-hashes/`).replaceAll(`"@noble/hashes/`, `"${up}noble-hashes/`));
}
const ortSrc = join(root, 'node_modules', 'onnxruntime-web', 'dist');
await mkdir(join(vendor, 'ort'), { recursive: true });
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await cp(join(ortSrc, f), join(vendor, 'ort', f));
}
// pdf.js reads PDFs for import, in the tab. Only the reader and its worker; no viewer, fonts or canvas.
const pdfSrc = join(root, 'node_modules', 'pdfjs-dist');
await mkdir(join(vendor, 'pdfjs'), { recursive: true });
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE']) {
  await cp(join(pdfSrc, f), join(vendor, 'pdfjs', f.replace('build/', '')));
}

// 3. the embedding model, if it has been fetched
const models = join(app, 'models');
await rm(models, { recursive: true, force: true });
if (existsSync(join(modelDir(), MODEL.onnx))) {
  await mkdir(models, { recursive: true });
  for (const f of [MODEL.onnx, MODEL.vocab]) await cp(join(modelDir(), f), join(models, f));
  console.log('model    copied');
} else {
  console.log('model    absent, the browser build will use BM25 alone (run npm run model)');
}

// 4. the fictional demo person, for the "Load demo notes" button
await cp(join(root, 'demo', 'notes.json'), join(app, 'demo-notes.json'));

const count = async (d: string): Promise<number> => (await readdir(d, { recursive: true })).length;
console.log(`core     ${String(PURE.length)} modules from src/`);
console.log(`vendor   ${String(await count(vendor))} files`);
console.log(`Built ${app}`);

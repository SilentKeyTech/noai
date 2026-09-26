/**
 * One-time install step: download the on-device embedding model into models/.
 *
 * This is the only moment NOAI's retrieval touches the network, it happens
 * before any note exists, and it downloads rather than uploads. Nothing about
 * the owner is in the request. Each file is checked against the SHA-256 pinned
 * in src/embed.ts and discarded if it does not match.
 *
 *   npm run model
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../src/crypto.ts';
import { MODEL, modelDir } from '../src/embed.ts';

const BASE = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main';
const FILES = [
  { url: `${BASE}/onnx/model_quantized.onnx`, name: MODEL.onnx, hash: MODEL.onnxSha256 },
  { url: `${BASE}/vocab.txt`, name: MODEL.vocab, hash: MODEL.vocabSha256 },
];

const dir = modelDir();
await mkdir(dir, { recursive: true });

for (const f of FILES) {
  const path = join(dir, f.name);
  if (existsSync(path) && sha256(await readFile(path)) === f.hash) {
    console.log(`ok       ${f.name} (already present, hash matches)`);
    continue;
  }
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.url} returned ${String(res.status)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== f.hash) throw new Error(`${f.name}: expected ${f.hash}, got ${got}. Not saved.`);
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
  console.log(`fetched  ${f.name}  ${(bytes.length / 1e6).toFixed(1)} MB  sha256 ${got.slice(0, 16)}`);
}
console.log(`Model ready in ${dir}`);

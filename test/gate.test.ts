/**
 * The egress gate is the only way out. src/gate.ts says so in its first line,
 * and this file is the test that line promises: every file in src/ and
 * web/app/lib is read the way the compiler reads it, and the build fails if
 * any of them reaches for the network. A comment that says "fetch" is not a
 * call; a call written as globalThis['fetch'] still counts.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readSource, type Source } from './source.ts';

const root = new URL('../', import.meta.url);
const SERVERS = ['src/server.ts', 'src/gateway-serve.ts', 'src/mcp-serve.ts'];

/** Globals that send or receive bytes, and the ways round a name: eval, Function, Reflect, process.binding, createRequire. */
const NET_GLOBALS = ['fetch', 'WebSocket', 'XMLHttpRequest', 'sendBeacon', 'EventSource', 'eval', 'Function', 'Reflect', 'binding', 'createRequire', 'Worker'];
/** Modules that open a socket, start a process or load a module by name. */
const NET_MODULES = [
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:http2', 'http', 'https', 'net', 'tls', 'dgram', 'http2', 'undici', 'ws', 'axios', 'node-fetch',
  'node:child_process', 'child_process', 'node:dns', 'dns', 'node:worker_threads', 'worker_threads', 'node:module', 'module', 'node:vm', 'vm',
];
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/**
 * Which of the forbidden names a file uses, as "name", "import x" or "string 'x'".
 * A server may import createServer from node:http, and only that: it listens, it does not call out.
 */
function reaches(s: Source, server = false): string[] {
  const found: string[] = [];
  for (const g of NET_GLOBALS) if (s.identifiers.has(g)) found.push(g);
  for (const m of NET_MODULES) {
    const names = s.imports.get(m);
    if (names && !(server && m === 'node:http' && names.every((n) => n === 'createServer'))) found.push(`import ${m}`);
    if (s.strings.has(m)) found.push(`string '${m}'`);
  }
  for (const g of NET_GLOBALS) if (s.strings.has(g)) found.push(`string '${g}'`);
  found.push(...s.computed);
  return found;
}

function files(dir: URL, ext: RegExp): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir.pathname, f);
    if (statSync(p).isDirectory()) out.push(...files(new URL(`${f}/`, dir), ext));
    else if (ext.test(f)) out.push(p);
  }
  return out;
}

describe('only the gate touches the network', () => {
  it('src/gate.ts is the one file in src/ that sends anything', () => {
    const offenders: string[] = [];
    for (const path of files(new URL('src/', root), CODE)) {
      const name = path.slice(root.pathname.length);
      if (name === 'src/gate.ts') continue;
      const found = reaches(readSource(path), SERVERS.includes(name));
      if (found.length) offenders.push(`${name}: ${found.join(', ')}`);
    }
    assert.deepEqual(offenders, []);
    assert.ok(readSource(new URL('src/gate.ts', root)).identifiers.has('fetch'), 'the gate itself sends through fetch');
  });

  it('the local servers import createServer from node:http and nothing else that reaches out', () => {
    for (const name of SERVERS) {
      const s = readSource(new URL(name, root));
      assert.deepEqual(s.imports.get('node:http'), ['createServer'], `${name} imports more than createServer from node:http`);
      assert.deepEqual(reaches(s, true), [], name);
      assert.deepEqual(reaches(s), ['import node:http'], `${name} would be caught anywhere else`);
    }
  });

  it('src/gate.ts listens on nothing: it has no server in it, and spells out every name it uses', () => {
    const s = readSource(new URL('src/gate.ts', root));
    for (const m of ['node:http', 'node:https', 'node:net', 'node:tls']) assert.equal(s.imports.has(m), false, `gate.ts imports ${m}`);
    assert.equal(s.identifiers.has('createServer'), false);
    for (const g of ['eval', 'Function', 'Reflect', 'binding', 'createRequire', 'Worker']) assert.equal(s.identifiers.has(g), false, g);
    assert.deepEqual(s.computed, []);
  });

  it('the pages outside web/app/lib send nothing, except app.js loading the demo notes from its own origin', () => {
    const app = new URL('web/app/', root);
    const offenders: string[] = [];
    for (const f of readdirSync(app)) {
      if (!CODE.test(f)) continue;
      const s = readSource(new URL(f, app));
      const found = reaches(s);
      if (f === 'app.js') {
        assert.deepEqual(found, ['fetch'], 'app.js may only use fetch');
        assert.equal(s.identifiers.get('fetch'), 1);
        const code = readFileSync(new URL(f, app), 'utf8');
        assert.deepEqual([...code.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]), ["'./demo-notes.json'"], 'app.js fetches one relative file of its own');
        continue;
      }
      if (found.length) offenders.push(`${f}: ${found.join(', ')}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('in the browser, gate.js sends to the relay, voice.js to the speech service, embedder.js fetches its own model, and no other file sends', () => {
    const lib = new URL('web/app/lib/', root);
    const offenders: string[] = [];
    for (const path of files(lib, /\.js$/)) {
      const name = path.slice(lib.pathname.length);
      const s = readSource(path);
      const found = reaches(s);
      if (name === 'gate.js') {
        assert.deepEqual(found, ['fetch'], 'gate.js may only use fetch');
        assert.equal(s.identifiers.get('fetch'), 1, 'gate.js calls fetch in one place, httpTransport');
        continue;
      }
      if (name === 'voice.js') {
        assert.deepEqual(found.sort(), ['WebSocket', 'fetch'], 'voice.js may only use fetch for its token and a WebSocket for audio');
        continue;
      }
      if (name === 'embedder.js') {
        assert.deepEqual(found, ['fetch'], 'embedder.js may only use fetch');
        assert.equal(s.identifiers.get('fetch'), 1, 'embedder.js fetches in one place, its own model files');
        assert.deepEqual([...readFileSync(path, 'utf8').matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]), ['new URL(path, base']);
        continue;
      }
      if (found.length) offenders.push(`${name}: ${found.join(', ')}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('the scanner sees through comments and into strings', () => {
    const s = readSource(new URL('fixtures/net-probe.ts', import.meta.url));
    assert.equal(s.identifiers.has('fetch'), false, 'fetch in a comment counted as a call');
    assert.equal(s.identifiers.has('WebSocket'), false, 'WebSocket in a comment counted as a call');
    assert.ok(s.strings.has('fetch'), 'globalThis["fetch"] not seen');
    assert.ok(s.strings.has('node:net'), 'a dynamic import of node:net not seen');
    assert.deepEqual(s.imports.get('node:http'), ['createServer'], 'a type-only import counted as a value import');
    assert.deepEqual(reaches(s), ['import node:http', "string 'node:net'", "string 'fetch'"]);
    assert.deepEqual(reaches(s, true), ["string 'node:net'", "string 'fetch'"]);
  });

  it('the scanner catches a name that is built rather than spelled out', () => {
    const s = readSource(new URL('fixtures/net-probe-built.ts', import.meta.url));
    assert.deepEqual(s.computed, ['computed property of (globalThis as any)', 'import() of a computed specifier', 'computed property of (globalThis as any)', 'import() of a computed specifier']);
    assert.ok(reaches(s).includes('eval') && reaches(s).includes('Function') && reaches(s).includes('Reflect') && reaches(s).includes('binding'));
    assert.ok(reaches(s).includes('import node:child_process') && reaches(s).includes('import node:worker_threads') && reaches(s).includes('import node:dns'));
    assert.ok(reaches(s).includes("string 'http'"), 'createRequire of http');
  });
});

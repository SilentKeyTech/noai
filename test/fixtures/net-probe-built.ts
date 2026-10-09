// A file for test/gate.test.ts to read. It never runs. Every line reaches for
// the network through a name that is put together rather than written down.
import { spawn } from 'node:child_process';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
const r = createRequire(import.meta.url);
export const a = () => (globalThis as any)['fe' + 'tch']('http://x');
export const b = () => import('node:' + 'http');
export const c = () => eval('fe' + 'tch')('http://x');
export const d = () => new Function('return fe' + 'tch')()('http://x');
export const e = () => Reflect.get(globalThis, 'fe' + 'tch')('http://x');
export const f = () => (process as any).binding('tcp_wrap');
export const g = () => r('http');
export const h = () => spawn('curl', ['http://x']);
export const i = () => dns.lookup('x', () => undefined);
export const j = () => new Worker('x', { eval: true });
export const k = () => (globalThis as any)[String.fromCharCode(102)];
export const l = async () => import(['node:http'].join(''));

/**
 * The browser demo and its relay on one local origin, for development and for
 * a container (Nebius Serverless). Netlify uses netlify/functions/relay.mjs.
 *
 *   node --env-file-if-exists=.env relay/serve.mjs          # http://127.0.0.1:7791
 *   NOAI_RELAY_ONLY=1 PORT=8080 node relay/serve.mjs        # relay alone, in a container
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { relay, voiceToken } from './core.mjs';

const root = normalize(join(new URL('../web/app/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const port = Number(process.env.PORT ?? process.env.NOAI_WEB_PORT ?? 7791);
const host = process.env.NOAI_RELAY_ONLY ? '0.0.0.0' : '127.0.0.1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.txt': 'text/plain', '.onnx': 'application/octet-stream', '.css': 'text/css' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname === '/api/voice-token') {
    const out = await voiceToken(new Request(`http://local${url.pathname}`, { method: req.method, headers: req.headers }), process.env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  if (url.pathname === '/api/chat') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://local${url.pathname}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
    const out = await relay(request, process.env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  if (process.env.NOAI_RELAY_ONLY) return void res.writeHead(404).end();
  const path = normalize(join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) return void res.writeHead(404).end('Not found');
  // The same policy netlify.toml sets on the public site, so local testing proves it.
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' wss://streaming.assemblyai.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(path).pipe(res);
}).listen(port, host, () => console.log(`NOAI web on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));

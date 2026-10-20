/**
 * Serve extension/test-page/chat.html at http://127.0.0.1:8737/noai-extension-test/
 * for trying the extension without an account on any chat site. Local only.
 *
 *   npm run extension:test-page
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const port = Number(process.env['PORT'] ?? 8737);
const page = new URL('../extension/test-page/chat.html', import.meta.url);

createServer((req, res) => {
  if (!req.url?.startsWith('/noai-extension-test/')) {
    res.writeHead(302, { location: '/noai-extension-test/' }).end();
    return;
  }
  readFile(page).then(
    (html) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html),
    () => res.writeHead(500).end(),
  );
}).listen(port, '127.0.0.1', () => {
  console.log(`Test page at http://127.0.0.1:${String(port)}/noai-extension-test/`);
});

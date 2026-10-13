// A shared provider key answers 429 when the team's per-minute cap is hit.
// The gateway waits and sends the same redacted bytes again instead of failing.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { fetchWithBackoff } from '../src/gate.ts';

async function server(statuses: number[]) {
  const bodies: string[] = [];
  const s = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      bodies.push(b);
      const status = statuses.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status }));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${String((s.address() as AddressInfo).port)}/`, bodies, close: () => s.close() };
}

describe('rate limit backoff', () => {
  it('retries a 429 with the same body and returns the answer', async () => {
    const s = await server([429, 429, 200]);
    const r = await fetchWithBackoff(s.url, { method: 'POST', body: 'redacted text' }, [10, 10, 10]);
    s.close();
    assert.equal(r.status, 200);
    assert.deepEqual(s.bodies, ['redacted text', 'redacted text', 'redacted text']);
  });
  it('gives up after the last wait and returns the 429', async () => {
    const s = await server([429, 429, 429]);
    const r = await fetchWithBackoff(s.url, { method: 'POST', body: 'x' }, [10, 10]);
    s.close();
    assert.equal(r.status, 429);
    assert.equal(s.bodies.length, 3);
  });
  it('does not retry other errors', async () => {
    const s = await server([400]);
    const r = await fetchWithBackoff(s.url, { method: 'POST', body: 'x' }, [10]);
    s.close();
    assert.equal(r.status, 400);
    assert.equal(s.bodies.length, 1);
  });
});

/**
 * The ledger under stress: appends that land at the same moment, and a file
 * whose last line was cut short by a crash. The chain must stay one chain, and
 * a damaged line must read as a break at that entry, never as an exception
 * after the bytes have already left.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { newId, scrub, sha256 } from '../src/crypto.ts';
import { append, ledgerPath, readLedger, readReceipts, receiptsPath, signDisclosure, signersOf, verifyLedger } from '../src/ledger.ts';
import type { DisclosureReceipt, SignedDisclosure } from '../src/types.ts';
import { createVault, type OpenVault, unwrapPrivateKey } from '../src/vault.ts';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function vault(): Promise<{ root: string; v: OpenVault }> {
  const root = await mkdtemp(join(tmpdir(), 'noai-ledger-'));
  dirs.push(root);
  return { root, v: await createVault(root, 'a passphrase used only by this test') };
}

/** A receipt as the gate writes one, signed by the device key, for a payload of `n` bytes. */
function receipt(v: OpenVault, n: number): SignedDisclosure {
  const r: DisclosureReceipt = {
    version: 1,
    kind: 'noai.disclosure',
    statement: 'This device sent exactly the payload whose hash is below, and nothing else, to the named model.',
    receiptId: newId(),
    at: new Date().toISOString(),
    endpoint: 'provider.test',
    model: 'm',
    payloadHash: sha256('x'.repeat(n)),
    payloadBytes: n,
    sources: [],
    redactions: {},
    responseHash: sha256(''),
    usage: null,
    signer: v.data.device.publicKey,
  };
  const pk = unwrapPrivateKey(v);
  const signed = signDisclosure(r, pk);
  scrub(pk);
  return signed;
}

describe('appends that land together', () => {
  it('are written one after another, so the chain has one entry per receipt, numbered in order', async () => {
    const { root, v } = await vault();
    const entries = await Promise.all(Array.from({ length: 12 }, (_, i) => append(root, receipt(v, i + 1))));
    assert.deepEqual(entries.map((e) => e.seq).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
    const chain = await readLedger(root);
    assert.deepEqual(chain.map((e) => e.seq), Array.from({ length: 12 }, (_, i) => i));
    const verdict = verifyLedger(chain, await readReceipts(root));
    assert.equal(verdict.valid, true, verdict.reason);
    assert.equal(verdict.length, 12);
  });

  it('still write in order when one of them fails', async () => {
    const { root, v } = await vault();
    const bad = { ...receipt(v, 1), receipt: undefined } as unknown as SignedDisclosure;
    const results = await Promise.allSettled([append(root, receipt(v, 1)), append(root, bad), append(root, receipt(v, 2))]);
    assert.equal(results[1]!.status, 'rejected');
    const chain = await readLedger(root);
    assert.deepEqual(chain.map((e) => e.seq), [0, 1]);
    assert.equal(verifyLedger(chain, await readReceipts(root)).valid, true);
  });
});

describe('a line cut short on disk', () => {
  it('in the chain reads as a break at that entry, and the next receipt is still written', async () => {
    const { root, v } = await vault();
    await append(root, receipt(v, 1));
    await append(root, receipt(v, 2));
    await appendFile(ledgerPath(root), '{"seq":2,"prev":"ab');
    const chain = await readLedger(root);
    assert.equal(chain.length, 3, 'the damaged line is still an entry, so later numbering holds');
    const verdict = verifyLedger(chain, await readReceipts(root));
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 2);
    assert.match(verdict.reason, /Entry 2 cannot be read/);

    const next = await append(root, receipt(v, 3));
    assert.equal(next.seq, 3);
    const lines = (await readFile(ledgerPath(root), 'utf8')).split('\n');
    assert.equal(lines.length, 5, 'the new entry starts on its own line');
    assert.equal(JSON.parse(lines[3]!).seq, 3);
    const after = verifyLedger(await readLedger(root), await readReceipts(root));
    assert.equal(after.brokenAt, 2, 'the break stays where the damage is');
    assert.equal(after.length, 4);
  });

  it('in the receipts file reads as a break at the entry whose receipt it was', async () => {
    const { root, v } = await vault();
    await append(root, receipt(v, 1));
    await append(root, receipt(v, 2));
    const lines = (await readFile(receiptsPath(root), 'utf8')).split('\n').filter(Boolean);
    await writeFile(receiptsPath(root), `${lines[0]!}\n${lines[1]!.slice(0, 40)}`);
    const receipts = await readReceipts(root);
    assert.equal(receipts.length, 1);
    const verdict = verifyLedger(await readLedger(root), receipts);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.brokenAt, 1);
  });

  for (const line of ['{}', '1', 'true', '[]', '"str"', 'null', '{"seq":"2"}']) {
    it(`in the chain, when it is valid JSON but not an entry (${line}), reads as a break there and the next receipt is still written`, async () => {
      const { root, v } = await vault();
      await append(root, receipt(v, 1));
      await append(root, receipt(v, 2));
      await appendFile(ledgerPath(root), `${line}\n`);
      const chain = await readLedger(root);
      assert.equal(chain.length, 3);
      const verdict = verifyLedger(chain, await readReceipts(root));
      assert.equal(verdict.valid, false);
      assert.equal(verdict.brokenAt, 2);
      assert.match(verdict.reason, /Entry 2 cannot be read/);
      const next = await append(root, receipt(v, 3));
      assert.equal(next.seq, 3);
      assert.equal(verifyLedger(await readLedger(root), await readReceipts(root)).brokenAt, 2);
    });

    it(`in the receipts file, when it is valid JSON but not a receipt (${line}), reads as a break at its entry and verify does not throw`, async () => {
      const { root, v } = await vault();
      await append(root, receipt(v, 1));
      await append(root, receipt(v, 2));
      const lines = (await readFile(receiptsPath(root), 'utf8')).split('\n').filter(Boolean);
      await writeFile(receiptsPath(root), `${lines[0]!}\n${line}\n`);
      const receipts = await readReceipts(root);
      assert.equal(receipts.length, 1);
      const verdict = verifyLedger(await readLedger(root), receipts);
      assert.equal(verdict.valid, false);
      assert.equal(verdict.brokenAt, 1);
      assert.equal(verifyLedger(await readLedger(root), [...receipts, JSON.parse(line)] as never).brokenAt, 1, 'a verifier handed the raw list must not throw either');
    });
  }

  it('in the receipts file, a receipt with no signer is left out, so the signer list does not throw', async () => {
    const { root, v } = await vault();
    await append(root, receipt(v, 1));
    await appendFile(receiptsPath(root), '{"receipt":{"receiptId":"abc"},"signature":"y"}\n');
    const receipts = await readReceipts(root);
    assert.equal(receipts.length, 1);
    assert.equal(signersOf(receipts).length, 1);
    assert.equal(signersOf([...receipts, JSON.parse('{"receipt":{"receiptId":"abc"},"signature":"y"}')] as never).length, 1, 'a verifier handed the raw list must not throw either');
    assert.equal(verifyLedger(await readLedger(root), receipts).valid, true);
  });

  it('does not change what an intact ledger reads as', async () => {
    const { root, v } = await vault();
    for (let i = 0; i < 3; i++) await append(root, receipt(v, i + 1));
    const verdict = verifyLedger(await readLedger(root), await readReceipts(root));
    assert.equal(verdict.valid, true);
    assert.equal(verdict.reason, 'All 3 disclosures are intact, signed and in order.');
    const raw = await readFile(ledgerPath(root), 'utf8');
    assert.ok(raw.endsWith('\n'));
    for (const line of raw.trim().split('\n')) assert.deepEqual(Object.keys(JSON.parse(line)), ['seq', 'prev', 'receiptId', 'at', 'model', 'payloadHash', 'payloadBytes', 'signature', 'entryHash']);
  });
});

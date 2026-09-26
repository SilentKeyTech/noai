/**
 * Local demo server, bound to 127.0.0.1 only. Answer on the left, the live
 * receipt tape on the right, and a tamper button that edits the ledger file
 * on disk so verification turns red for real, not in the UI.
 */
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { respond, sharedEmbedder } from './agent.ts';
import { configFromEnv, GateRefused } from './gate.ts';
import { noaiHome } from './home.ts';
import { ledgerPath, readLedger, readReceipts, verifyLedger } from './ledger.ts';
import { addNote, createVault, forgetNote, type OpenVault, openVault, readDisclosure, readNotes, signerFingerprint, vaultPathFor } from './vault.ts';

const root = noaiHome();
const port = Number(process.env.NOAI_PORT ?? 7788);
let vault: OpenVault | null = null;

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let s = '';
  for await (const c of req) s += String(c);
  return s ? (JSON.parse(s) as Record<string, string>) : {};
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function tape(): Promise<unknown> {
  const entries = await readLedger(root);
  const receipts = await readReceipts(root);
  const byId = new Map(receipts.map((r) => [r.receipt.receiptId, r]));
  return {
    verdict: verifyLedger(entries, receipts),
    entries: entries.map((e) => ({
      ...e,
      receipt: byId.get(e.receiptId)?.receipt ?? null,
      disclosed: vault ? readDisclosure(vault, e.receiptId) : null,
    })),
  };
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'GET /': async (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(new URL('../web/index.html', import.meta.url)));
  },
  'GET /api/state': async (_q, res) => {
    send(res, 200, {
      exists: existsSync(vaultPathFor(root)),
      unlocked: !!vault,
      device: vault ? signerFingerprint(vault.data.device.publicKey) : null,
      notes: vault ? readNotes(vault).map((n) => ({ id: n.id, title: n.kind === 'memory' ? n.body : n.title, addedAt: n.addedAt, kind: n.kind })) : [],
      retriever: (await sharedEmbedder()) ? 'hybrid' : 'bm25',
      model: configFromEnv(root).model,
      keySet: !!process.env.NEBIUS_API_KEY,
    });
  },
  'POST /api/unlock': async (req, res) => {
    const { passphrase = '' } = await body(req);
    vault = existsSync(vaultPathFor(root)) ? await openVault(root, passphrase) : await createVault(root, passphrase);
    send(res, 200, { ok: true });
  },
  'POST /api/lock': async (_q, res) => {
    vault?.masterKey.fill(0);
    vault = null;
    send(res, 200, { ok: true });
  },
  'POST /api/notes': async (req, res) => {
    if (!vault) return send(res, 401, { error: 'Locked.' });
    const { title = '', text = '' } = await body(req);
    if (!title.trim() || !text.trim()) return send(res, 400, { error: 'Title and text are required.' });
    const n = await addNote(vault, title.trim(), text.trim());
    send(res, 200, { id: n.id });
  },
  'POST /api/ask': async (req, res) => {
    if (!vault) return send(res, 401, { error: 'Locked.' });
    const { question = '' } = await body(req);
    if (!question.trim()) return send(res, 400, { error: 'Ask something.' });
    const r = await respond(vault, configFromEnv(root), question.trim());
    if (r.kind === 'memory') return send(res, 200, { kind: 'memory', id: r.note.id, fact: r.note.body, bytesSent: 0 });
    send(res, 200, {
      kind: 'answer',
      answer: r.answer,
      rawAnswer: r.rawAnswer,
      used: r.used,
      ms: r.ms,
      seq: r.entry.seq,
      retriever: r.retriever,
      remembered: r.remembered.map((n) => ({ id: n.id, fact: n.body })),
    });
  },
  'POST /api/forget': async (req, res) => {
    if (!vault) return send(res, 401, { error: 'Locked.' });
    const { id = '' } = await body(req);
    send(res, (await forgetNote(vault, id)) ? 200 : 404, { ok: true });
  },
  'GET /api/tape': async (_q, res) => send(res, 200, await tape()),
  'POST /api/tamper': async (_q, res) => {
    const path = ledgerPath(root);
    const lines = existsSync(path) ? (await readFile(path, 'utf8')).split('\n').filter(Boolean) : [];
    if (!lines.length) return send(res, 400, { error: 'Nothing to tamper with yet. Ask a question first.' });
    await copyFile(path, `${path}.before-tamper`);
    // Rewrite history: claim the first disclosure was smaller than it was.
    const first = JSON.parse(lines[0] as string) as { payloadBytes: number };
    first.payloadBytes = Math.max(1, Math.floor(first.payloadBytes / 4));
    lines[0] = JSON.stringify(first);
    await writeFile(path, `${lines.join('\n')}\n`);
    send(res, 200, { ok: true, edited: 0 });
  },
  'POST /api/restore': async (_q, res) => {
    const path = ledgerPath(root);
    if (!existsSync(`${path}.before-tamper`)) return send(res, 400, { error: 'No backup to restore.' });
    await copyFile(`${path}.before-tamper`, path);
    send(res, 200, { ok: true });
  },
};

createServer((req, res) => {
  const key = `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0] ?? '/'}`;
  const route = routes[key];
  if (!route) return send(res, 404, { error: 'Not found.' });
  route(req, res).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    send(res, e instanceof GateRefused ? 403 : 500, { error: msg });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`NOAI on http://127.0.0.1:${String(port)}  (data in ${root})`);
  void sharedEmbedder().then((e) => console.log(e ? `Retrieval: BM25 + ${e.name}, on device` : 'Retrieval: BM25 only (run npm run model for on-device embeddings)'));
});

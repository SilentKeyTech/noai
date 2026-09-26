/** The browser demo's UI. All the work is in lib/; this file only draws it. */
import { respond } from './lib/agent.js';
import { loadEmbedder } from './lib/embedder.js';
import { GateRefused } from './lib/gate.js';
import { exportFiles, readLedger, readReceipts, verifyLedger } from './lib/ledger.js';
import { idbStore } from './lib/store.js';
import { addNote, closeVault, createVault, forgetNote, openVault, readDisclosure, readNotes, signerFingerprint, vaultExists } from './lib/vault.js';

const MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const cfg = { relayUrl: './api/chat', model: MODEL, maxTokens: 4096, maxPayloadBytes: 8000 };
const store = idbStore();
let vault = null;
let embedder = null;
let modelLoading = true;
const embedderReady = loadEmbedder()
  .then((e) => { embedder = e; })
  .catch((e) => console.warn(`Embeddings not used: ${e.message}`))
  .finally(() => { modelLoading = false; drawMeta(); });

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** Escape, then mark every placeholder the model saw instead of a real value. */
const withPlaceholders = (s) => esc(s).replace(/\[[A-Z]+_\d+\]/g, (p) => `<span class="ph">${p}</span>`);

function drawMeta() {
  const retrieval = modelLoading
    ? 'loading the on-device search model (22 MB, once; it never leaves this tab)'
    : embedder ? 'BM25 + on-device embeddings' : 'BM25';
  $('meta').textContent = `${MODEL}${vault ? ` · device ${signerFingerprint(vault.data.device.publicKey)}` : ''} · retrieval ${retrieval}`;
}

async function refresh() {
  const exists = await vaultExists(store);
  $('lockhint').textContent = exists
    ? 'This browser holds a sealed vault. Only its passphrase opens it.'
    : 'No vault in this browser yet. The passphrase you choose now creates one. Forget it and the vault is gone: there is no reset.';
  $('unlock').textContent = exists ? 'Unlock' : 'Create vault';
  $('lock').classList.toggle('hidden', !!vault);
  $('app').classList.toggle('hidden', !vault);
  if (vault) {
    const notes = await readNotes(vault);
    $('notes').innerHTML = notes.map((n) => `<li>${n.kind === 'memory' ? '<span class="tag">memory</span>' : ''}<span>${esc(n.kind === 'memory' ? n.body : n.title)}</span><span class="seal">sealed</span><button class="forget" data-id="${esc(n.id)}" aria-label="Forget ${esc(n.kind === 'memory' ? 'this memory' : n.title)}">forget</button></li>`).join('') || '<li class="empty">Empty. Load the demo notes or add your own.</li>';
  }
  drawMeta();
  await drawTape();
}

async function drawTape() {
  const entries = await readLedger(store);
  const receipts = await readReceipts(store);
  const v = verifyLedger(entries, receipts);
  $('verdict').className = `verdict ${v.valid ? 'ok' : 'bad'}`;
  $('verdict').textContent = `${v.valid ? 'VERIFIED  ' : 'BROKEN  '}${v.reason}`;
  const byId = new Map(receipts.map((r) => [r.receipt.receiptId, r.receipt]));
  const cards = [];
  for (const e of entries.slice().reverse()) {
    const r = byId.get(e.receiptId) ?? {};
    const disclosed = vault ? await readDisclosure(vault, e.receiptId) : null;
    const reds = Object.entries(r.redactions ?? {}).map(([k, n]) => `<span class="chip red">${esc(k)} ×${n} redacted</span>`).join('');
    const broken = !v.valid && v.brokenAt === e.seq;
    const n = (r.sources ?? []).length;
    cards.push(`<div class="link${broken ? ' broken' : ''}"><div class="rail"></div><div class="card${broken ? ' broken' : ''}">
      <div class="top"><b>#${e.seq}</b><span>${esc(new Date(e.at).toLocaleTimeString())}</span><span class="out">${e.payloadBytes} bytes out</span></div>
      <div class="chips"><span class="chip">${n} passage${n === 1 ? '' : 's'}</span>${reds || '<span class="chip">no redactions needed</span>'}${r.usage ? `<span class="chip">${r.usage.promptTokens} in / ${r.usage.completionTokens} out tokens</span>` : ''}</div>
      ${disclosed ? `<details><summary>Exactly what the model saw</summary><pre>${withPlaceholders(disclosed)}</pre></details>` : ''}
      <p class="hash">payload sha256 ${esc(e.payloadHash)}<br>entry ${esc(e.entryHash)} · prev ${esc(e.prev.slice(0, 16))}…</p>
    </div></div>`);
  }
  $('tape').innerHTML = cards.join('');
}

$('unlock').onclick = async () => {
  const pass = $('pass').value;
  if (pass.length < 8) return void ($('lockerr').textContent = 'Use at least 8 characters. A short passphrase is the weakest part of any vault.');
  $('lockerr').textContent = '';
  $('unlock').disabled = true;
  const progress = (p) => { $('lockhint').textContent = `Deriving the key with scrypt, on this device: ${Math.round(p * 100)}%`; };
  try {
    vault = (await vaultExists(store)) ? await openVault(store, pass, progress) : await createVault(store, pass, progress);
    $('pass').value = '';
  } catch (e) {
    $('lockerr').textContent = e.message;
  }
  $('unlock').disabled = false;
  await refresh();
};
$('pass').onkeydown = (e) => { if (e.key === 'Enter') $('unlock').click(); };

$('ask').onclick = async () => {
  const q = $('q').value.trim();
  if (!q) return;
  $('ask').disabled = true;
  $('answer').className = 'answer';
  $('answer').textContent = 'Ranking in this tab, redacting, sending through the gate...';
  $('stats').textContent = '';
  try {
    await embedderReady;
    const r = await respond(vault, cfg, q, { embedder });
    if (r.kind === 'memory') {
      $('answer').innerHTML = `<div class="kept">Kept in your vault: ${esc(r.note.body)}</div>`;
      $('stats').textContent = '0 bytes sent. Saving a memory never calls the model and writes no receipt, because nothing left.';
      $('q').value = '';
    } else {
      $('answer').innerHTML = esc(r.answer).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + r.remembered.map((m) => `<div class="kept">Kept in your vault: ${esc(m.body)}</div>`).join('');
      $('stats').textContent = `${r.used} passage${r.used === 1 ? '' : 's'} disclosed · chosen by ${r.retriever === 'hybrid' ? 'BM25 + on-device embeddings' : 'BM25'} · receipt #${r.entry.seq} · ${r.ms} ms round trip`;
    }
  } catch (e) {
    $('answer').className = 'answer err';
    $('answer').textContent = e instanceof GateRefused ? e.message : `Not answered: ${e.message}`;
  }
  $('ask').disabled = false;
  await refresh();
};
$('q').onkeydown = (e) => { if (e.key === 'Enter') $('ask').click(); };

$('seed').onclick = async () => {
  const notes = await (await fetch('./demo-notes.json')).json();
  for (const n of notes) await addNote(vault, n.title, n.body);
  await refresh();
};
$('add').onclick = async () => {
  const title = $('nt').value.trim();
  const body = $('nb').value.trim();
  if (!title || !body) return;
  await addNote(vault, title, body);
  $('nt').value = '';
  $('nb').value = '';
  await refresh();
};
$('notes').onclick = async (e) => {
  const b = e.target.closest('.forget');
  if (!b || !confirm('Delete this sealed entry from the vault? This cannot be undone.')) return;
  await forgetNote(vault, b.dataset.id);
  await refresh();
};
$('lockbtn').onclick = async () => { closeVault(vault); vault = null; await refresh(); };
$('wipe').onclick = async () => {
  if (!confirm('Delete the vault, receipts and chain from this browser? There is no other copy.')) return;
  closeVault(vault);
  vault = null;
  for (const k of ['vault', 'ledger', 'receipts', 'ledger.before-tamper']) await store.del(k);
  await refresh();
};

$('verify').onclick = drawTape;
$('tamper').onclick = async () => {
  const entries = await readLedger(store);
  if (!entries.length) return alert('Nothing to tamper with yet. Ask a question first.');
  await store.put('ledger.before-tamper', entries);
  // Rewrite history: claim the first disclosure was smaller than it was.
  entries[0].payloadBytes = Math.max(1, Math.floor(entries[0].payloadBytes / 4));
  await store.put('ledger', entries);
  await drawTape();
};
$('restore').onclick = async () => {
  const backup = await store.get('ledger.before-tamper');
  if (!backup) return alert('No backup to restore.');
  await store.put('ledger', backup);
  await drawTape();
};
$('export').onclick = async () => {
  for (const [name, text] of Object.entries(await exportFiles(store))) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
};

refresh();

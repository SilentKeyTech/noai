/** The browser demo's UI. All the work is in lib/; this file only draws it. */
import { checkIn, respond } from './lib/agent.js';
import { CHECKIN_KIND, routines, whenSaid } from './lib/core/checkins.js';
import { SKILLS } from './lib/core/skills.js';
import { loadEmbedder } from './lib/embedder.js';
import { GateRefused } from './lib/gate.js';
import { exportFiles, readLedger, readReceipts, verifyLedger } from './lib/ledger.js';
import { idbStore } from './lib/store.js';
import { listen, receiptVoice } from './lib/voice.js';
import { ingestText, newOnly, parsePdfText } from './lib/core/ingest.js';
import { addNote, closeVault, createVault, forgetNote, openVault, readDisclosure, readNotes, readProfile, saveProfile, signerFingerprint, vaultExists } from './lib/vault.js';
import { mountCompanion } from './companion.js';

const MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const FAST_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
// The relay's host cuts a request off after its own limit, so the page gives up a little sooner and falls back.
const cfg = { relayUrl: './api/chat', model: MODEL, fallbackModel: FAST_MODEL, timeoutMs: 25000, maxTokens: 4096, maxPayloadBytes: 8000 };
const store = idbStore();
let vault = null;
let embedder = null;

const $ = (id) => document.getElementById(id);
// The face that shows what NOAI is doing. It only reports what the code below did.
const pal = mountCompanion({ face: $('face'), line: $('cline'), picker: $('chars'), label: $('cname') });
pal.set('sleep');
let profile = {};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** Escape first, then mark every placeholder the model saw in place of a real value. */
const withPlaceholders = (s) => esc(s).replace(/\[[A-Z]+_\d+\]/g, '<mark class="ph">$&</mark>');
const short = (h) => (h && h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h ?? '');

// Moment 2: the first visit downloads the model. Say what it is and how far along.
const embedderReady = loadEmbedder((f) => {
  $('modelbar').value = Math.round(f * 100);
  $('modeltext').textContent = `Loading the on-device search model, about 34 MB with its runtime. It never leaves this tab. ${Math.round(f * 100)}%`;
})
  .then((e) => {
    embedder = e;
    const box = $('modelload');
    box.classList.add('done');
    $('modeltext').textContent = e ? 'On-device search model ready, checked against its pinned SHA-256.' : 'On-device model not loaded. Using BM25 keyword search.';
    // Fade, then take the notice out of the layout so it leaves no gap above the input.
    if (e) setTimeout(() => { box.classList.add('gone'); setTimeout(() => box.classList.add('hidden'), 700); }, 4000);
  })
  .catch((e) => {
    $('modelload').classList.add('done');
    $('modeltext').textContent = `On-device model not used (${e.message}). Using BM25 keyword search.`;
  })
  .finally(drawMeta);

function drawMeta() {
  const retrieval = embedder ? 'BM25 + on-device embeddings' : 'BM25';
  $('meta').textContent = `${MODEL}${vault ? ` · device ${signerFingerprint(vault.data.device.publicKey)}` : ''} · retrieval ${retrieval}`;
}

for (const s of Object.values(SKILLS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = s.label;
  b.onclick = () => {
    $('q').value = s.starter;
    $('q').focus();
  };
  $('skills').append(b);
}

async function refresh() {
  const exists = await vaultExists(store);
  $('lockhint').textContent = exists
    ? 'This browser holds a sealed vault. Only its passphrase opens it.'
    : 'No vault in this browser yet. The passphrase you choose now creates one. Forget it and the vault is gone: there is no reset.';
  $('unlock').textContent = exists ? 'Unlock' : 'Create vault';
  $('lock').classList.toggle('hidden', !!vault);
  $('callme').disabled = $('callmesave').disabled = !vault;
  $('callmehint').textContent = vault ? 'Sealed in your vault and never sent.' : 'Sealed in your vault and never sent. Unlock first.';
  $('app').classList.toggle('hidden', !vault);
  if (vault) {
    const notes = await readNotes(vault);
    const reminders = notes.filter((n) => n.kind === 'reminder').sort((a, b) => (a.title < b.title ? -1 : 1));
    const rest = notes.filter((n) => n.kind !== 'reminder' && n.kind !== CHECKIN_KIND);
    drawCheckins(notes);
    const item = (n) => {
      if (n.kind === 'reminder') return `<li class="rem"><span class="when">${esc(n.title)}</span><span>${esc(n.body)}</span><span class="seal">sealed</span><button class="forget" data-id="${esc(n.id)}" aria-label="Forget this reminder">forget</button></li>`;
      const label = n.kind === 'memory' ? n.body : n.title;
      return `<li>${n.kind === 'memory' ? '<span class="tag">memory</span>' : ''}<span>${esc(label)}</span><span class="seal">sealed</span><button class="forget" data-id="${esc(n.id)}" aria-label="Forget ${esc(n.kind === 'memory' ? 'this memory' : n.title)}">forget</button></li>`;
    };
    $('notes').innerHTML = [...reminders, ...rest].map(item).join('') || '<li class="empty">Empty. Load the demo notes or add your own.</li>';
  }
  drawMeta();
  await drawTape();
}

// The highest receipt already on screen, so only a receipt that just arrived rises in.
let shownSeq = null;

/** Today's check-ins, newest first, and the routines as one-tap buttons. */
function drawCheckins(notes) {
  const now = new Date();
  const all = notes.filter((n) => n.kind === CHECKIN_KIND).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  const today = all.filter((n) => new Date(n.addedAt).toDateString() === now.toDateString());
  $('routines').innerHTML = routines(all).map((r, i) => `<button type="button" data-i="${i}" aria-label="Check in: ${esc(r.who)} ${esc(r.what)}"><span class="tick" aria-hidden="true">\u2713</span><span><span class="who">${esc(r.who === 'me' ? 'Me' : r.who)}</span> ${esc(r.what)}</span></button>`).join('');
  $('routines').dataset.list = JSON.stringify(routines(all));
  $('cilist').innerHTML = today.map((n) => `<li><span class="t">${esc(whenSaid(new Date(n.addedAt), now).replace('today at ', ''))}</span><span class="w"><b>${esc(n.title === 'me' ? 'Me' : n.title)}</b> ${esc(n.body)}</span><button class="forget" data-id="${esc(n.id)}" aria-label="Forget this check-in">forget</button></li>`).join('')
    || '<li class="none">No check-ins yet today.</li>';
}

async function drawTape() {
  const entries = await readLedger(store);
  const top = entries.reduce((m, e) => Math.max(m, e.seq), -1);
  const seenBefore = shownSeq;
  shownSeq = top;
  const receipts = await readReceipts(store);
  const v = verifyLedger(entries, receipts);
  $('verdict').className = `verdict ${v.valid ? 'ok' : 'bad'}`;
  $('verdict').innerHTML = `<b class="stamp">${v.valid ? 'VERIFIED' : 'BROKEN'}</b><span>${esc(v.reason)}</span>`;
  const byId = new Map(receipts.map((r) => [r.receipt.receiptId, r.receipt]));
  const cards = [];
  for (const e of entries.slice().reverse()) {
    const r = byId.get(e.receiptId) ?? {};
    const disclosed = vault ? await readDisclosure(vault, e.receiptId) : null;
    const reds = Object.entries(r.redactions ?? {}).map(([k, n]) => `<span class="chip red">${esc(k)} ×${n} redacted</span>`).join('');
    const broken = !v.valid && v.brokenAt === e.seq;
    const n = (r.sources ?? []).length;
    const outcome = r.outcome ? `<span class="chip">${r.outcome === 'timeout' ? 'no answer in time' : 'no answer'}</span>` : '';
    const fresh = seenBefore !== null && e.seq > seenBefore;
    cards.push(`<div class="link${broken ? ' broken' : ''}${fresh ? ' new' : ''}"><div class="rail"></div><div class="card${broken ? ' broken' : ''}">
      <div class="top"><b>#${e.seq}</b><span>${esc(new Date(e.at).toLocaleTimeString())}</span><span class="model">${esc(e.model.split('/').pop())}</span><span class="out">${e.payloadBytes} bytes out</span></div>
      <div class="chips"><span class="chip">${n} passage${n === 1 ? '' : 's'}</span>${reds || '<span class="chip">no redactions needed</span>'}${outcome}${r.usage ? `<span class="chip">${r.usage.promptTokens} in / ${r.usage.completionTokens} out tokens</span>` : ''}</div>
      ${disclosed ? `<details><summary>Exactly what the model saw</summary><pre>${withPlaceholders(disclosed)}</pre><p class="hash">payload sha256 ${esc(e.payloadHash)}<br>entry ${esc(e.entryHash)}<br>prev ${esc(e.prev)}</p></details>` : ''}
      <p class="hash"><span title="${esc(e.payloadHash)}">sha256 ${esc(short(e.payloadHash))}</span> · <span title="${esc(e.entryHash)}">entry ${esc(short(e.entryHash))}</span></p>
    </div></div>`);
  }
  $('tape').innerHTML = cards.join('');
}

/** After a tamper, bring the receipt where the chain breaks into view; it is often the oldest, at the bottom. */
async function drawTapeShowingBreak() {
  await drawTape();
  if ($('verdict').classList.contains('bad')) pal.set('alarm');
  document.querySelector('#tape .link.broken')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
    profile = await readProfile(vault);
    pal.setName(profile.name);
    $('callme').value = profile.name ?? '';
    pal.set('happy', 'hello');
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
  pal.set('think');
  $('answer').className = 'answer';
  $('answer').textContent = 'Ranking in this tab, redacting, sending through the gate...';
  $('stats').textContent = '';
  try {
    await embedderReady;
    const r = await respond(vault, cfg, q, { embedder });
    if (r.kind === 'checkin') {
      $('answer').innerHTML = `<div class="kept">Checked in: ${esc(r.note.title === 'me' ? 'you' : r.note.title)} ${esc(r.note.body)}, ${esc(whenSaid(new Date(r.note.addedAt), new Date()))}.</div>`;
      $('stats').innerHTML = '<b>0 bytes sent.</b> A check-in is sealed on this device with its time, and never calls the model.';
      $('q').value = '';
      pal.set('kept', 'checkin', { who: r.note.title, what: r.note.body });
    } else if (r.kind === 'checkin-answer') {
      $('answer').textContent = r.answer;
      $('stats').innerHTML = '<b>0 bytes sent.</b> Answered on this device from your sealed check-ins. No model call and no receipt.';
      pal.set('happy', 'local', { yes: !!r.found });
    } else if (r.kind === 'memory') {
      $('answer').innerHTML = `<div class="kept">Kept in your vault: ${esc(r.note.body)}</div>`;
      $('stats').innerHTML = '<b>0 bytes sent.</b> Saving a memory never calls the model and writes no receipt, because nothing left.';
      $('q').value = '';
      pal.set('kept');
    } else {
      pal.set('happy', 'happy', { sent: r.used, hid: Object.values(r.signed?.receipt?.redactions ?? {}).reduce((a, b) => a + b, 0) });
      const kept = [...r.remembered.map((m) => `Kept in your vault: ${esc(m.body)}`), ...r.reminders.map((m) => `Reminder set for ${esc(m.title)}: ${esc(m.body)}`)];
      $('answer').innerHTML = esc(r.answer).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + kept.map((k) => `<div class="kept">${k}</div>`).join('');
      const who = r.fellBack ? ' · <span class="fell">answered by Nemotron Nano, because Nemotron Super did not answer in time</span>' : '';
      $('stats').innerHTML = `${r.used} passage${r.used === 1 ? '' : 's'} disclosed · chosen by ${r.retriever === 'hybrid' ? 'BM25 + on-device embeddings' : 'BM25'}${r.skill ? ` · skill: ${esc(SKILLS[r.skill].label.toLowerCase())}` : ''} · receipt #${r.entry.seq} · ${r.ms} ms round trip${who}`;
    }
    if (spoken) {
      $('stats').innerHTML += ` · <span class="voice">${esc(spoken)}</span>`;
      const said = r.kind === 'memory' ? `Kept in your vault: ${r.note.body}` : r.kind === 'checkin' ? `Checked in: ${r.note.title} ${r.note.body}` : r.answer;
      if (!sayAloud(said.replace(/\*\*/g, '').replace(/\[P\d+\]/g, ''))) $('stats').innerHTML += ' · <span class="voice">no on-device voice in this browser, so the answer is not read aloud</span>';
    }
  } catch (e) {
    pal.set('oops');
    $('answer').className = 'answer err';
    $('answer').textContent = e instanceof GateRefused ? e.message : `Not answered: ${e.message}`;
  }
  $('ask').disabled = false;
  spoken = '';
  await refresh();
};
$('q').onkeydown = (e) => { if (e.key === 'Enter') $('ask').click(); };
$('q').oninput = () => { if (vault && pal.state !== 'think') pal.set($('q').value ? 'listen' : 'idle', $('q').value ? 'listen' : null); };
$('callmesave').onclick = async () => {
  if (!vault) return;
  profile = { ...profile, name: $('callme').value.trim().slice(0, 40) };
  await saveProfile(vault, profile);
  pal.setName(profile.name);
  pal.set('happy', 'hello');
};
$('callme').onkeydown = (e) => { if (e.key === 'Enter') $('callmesave').click(); };

// Voice: speak a question, hear the answer. The audio goes to AssemblyAI and is receipted;
// the answer is read aloud only by a voice that runs on this device, so it adds no second egress.
let session = null;
let spoken = '';
function sayAloud(text) {
  if (!('speechSynthesis' in window) || !text) return false;
  const local = speechSynthesis.getVoices().filter((v) => v.localService);
  const lang = /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en';
  const voice = local.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? (lang === 'en' ? local[0] : undefined);
  if (!voice) return false;
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  return true;
}
$('speak').onclick = async () => {
  if (!vault) return;
  if (!session) {
    $('speak').disabled = true;
    $('answer').className = 'answer';
    $('answer').textContent = 'Listening. Everything you say now is streamed to AssemblyAI to be written down, and receipted. Press Stop when you are done.';
    $('stats').textContent = '';
    try {
      session = await listen({ onPartial: (t) => ($('q').value = t) });
      pal.set('listen');
      $('speak').textContent = 'Stop';
      $('speak').classList.add('live');
      $('speak').setAttribute('aria-pressed', 'true');
    } catch (e) {
      session = null;
      $('answer').className = 'answer err';
      $('answer').textContent = `Voice did not start: ${e.message}`;
    }
    $('speak').disabled = false;
    return;
  }
  $('speak').disabled = true;
  const s = session;
  session = null;
  $('speak').textContent = 'Speak';
  $('speak').classList.remove('live');
  $('speak').setAttribute('aria-pressed', 'false');
  try {
    const heard = await s.stop();
    if (heard.audioBytes > 0) {
      const { entry } = await receiptVoice(vault, heard);
      spoken = `${(heard.audioBytes / 1024).toFixed(0)} KB of audio sent to AssemblyAI to be written down · receipt #${entry.seq}`;
    }
    if (!heard.transcript) {
      $('answer').textContent = 'Nothing was heard.';
      $('stats').textContent = spoken;
      spoken = '';
    } else {
      $('q').value = heard.transcript;
      $('ask').click();
    }
  } catch (e) {
    $('answer').className = 'answer err';
    $('answer').textContent = `Voice stopped: ${e.message}`;
  }
  $('speak').disabled = false;
  await refresh();
};

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
$('impbtn').onclick = () => $('imp').click();
$('imp').onchange = async () => {
  const files = [...$('imp').files];
  $('imp').value = '';
  if (files.length === 0) return;
  const lines = [];
  for (const f of files) {
    try {
      const parsed = /\.pdf$/i.test(f.name)
        ? parsePdfText(await (await import('./lib/pdf.js')).pdfPages(new Uint8Array(await f.arrayBuffer())), f.name)
        : ingestText(await f.text(), f.name);
      const fresh = newOnly(parsed.notes, await readNotes(vault));
      for (const d of fresh) await addNote(vault, d.title, d.body);
      const dup = parsed.notes.length - fresh.length;
      lines.push(`${esc(f.name)}: sealed ${fresh.length} note${fresh.length === 1 ? '' : 's'}${dup ? `, ${dup} already in the vault` : ''}.${parsed.warnings.map((w) => ` ${esc(w)}`).join('')}`);
    } catch (e) {
      lines.push(`${esc(f.name)}: not imported. ${esc(e.message)}`);
    }
  }
  $('impstat').innerHTML = `${lines.join('<br>')}<br>Nothing was sent.`;
  await refresh();
};
async function tapCheckin(who, what) {
  if (!vault || !who.trim() || !what.trim()) return;
  const r = await checkIn(vault, who, what);
  $('answer').className = 'answer';
  $('answer').innerHTML = `<div class="kept">Checked in: ${esc(r.note.title === 'me' ? 'you' : r.note.title)} ${esc(r.note.body)}, ${esc(whenSaid(new Date(r.note.addedAt), new Date()))}.</div>`;
  $('stats').innerHTML = '<b>0 bytes sent.</b> A check-in is sealed on this device with its time, and never calls the model.';
  pal.set('kept', 'checkin', { who: r.note.title, what: r.note.body });
  await refresh();
}
$('routines').onclick = (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  const r = JSON.parse($('routines').dataset.list || '[]')[Number(b.dataset.i)];
  if (r) tapCheckin(r.who, r.what);
};
$('ciadd').onclick = async () => {
  await tapCheckin($('ciwho').value, $('ciwhat').value);
  $('ciwhat').value = '';
};
$('ciwhat').onkeydown = (e) => { if (e.key === 'Enter') $('ciadd').click(); };
$('cilist').onclick = async (e) => {
  const b = e.target.closest('.forget');
  if (!b || !confirm('Delete this check-in from the vault? This cannot be undone.')) return;
  await forgetNote(vault, b.dataset.id);
  await refresh();
};
$('notes').onclick = async (e) => {
  const b = e.target.closest('.forget');
  if (!b || !confirm('Delete this sealed entry from the vault? This cannot be undone.')) return;
  await forgetNote(vault, b.dataset.id);
  await refresh();
};
$('lockbtn').onclick = async () => { closeVault(vault); vault = null; pal.setName(''); pal.set('sleep'); await refresh(); };
$('wipe').onclick = async () => {
  if (!confirm('Delete the vault, receipts and chain from this browser? There is no other copy.')) return;
  closeVault(vault);
  vault = null;
  pal.setName('');
  pal.set('sleep');
  for (const k of ['vault', 'ledger', 'receipts', 'ledger.before-tamper', 'receipts.before-tamper']) await store.del(k);
  await refresh();
};

/** One backup of both files before the first tamper. An older page version saved only the ledger, so both are checked. */
async function backup() {
  if (!(await store.get('ledger.before-tamper')) || !(await store.get('receipts.before-tamper'))) {
    await store.put('ledger.before-tamper', await readLedger(store));
    await store.put('receipts.before-tamper', await readReceipts(store));
  }
}
$('verify').onclick = drawTape;
$('tamper').onclick = async () => {
  const entries = await readLedger(store);
  if (!entries.length) return alert('Nothing to tamper with yet. Ask a question first.');
  await backup();
  // Rewrite history: claim the first disclosure was smaller than it was.
  entries[0].payloadBytes = Math.max(1, Math.floor(entries[0].payloadBytes / 4));
  await store.put('ledger', entries);
  await drawTapeShowingBreak();
};
$('delreceipt').onclick = async () => {
  const receipts = await readReceipts(store);
  if (!receipts.length) return alert('No receipts yet. Ask a question first.');
  await backup();
  // Hide one disclosure: delete the most recent receipt and keep the chain.
  await store.put('receipts', receipts.slice(0, -1));
  await drawTapeShowingBreak();
};
$('restore').onclick = async () => {
  const ledger = await store.get('ledger.before-tamper');
  const receipts = await store.get('receipts.before-tamper');
  if (!ledger || !receipts) return alert('No backup to restore.');
  await store.put('ledger', ledger);
  await store.put('receipts', receipts);
  await store.del('ledger.before-tamper');
  await store.del('receipts.before-tamper');
  await drawTape();
  if (vault) pal.set('happy', 'restored');
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

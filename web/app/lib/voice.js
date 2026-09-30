// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Voice, browser edition. The second of exactly two files in web/app/lib that
 * send anything, and test/web.test.ts holds it to one destination.
 *
 * Speaking to NOAI means audio leaves the device, so it is treated like any
 * other disclosure and receipted on the same signed chain:
 *   - the page asks the relay on this origin for a one-minute AssemblyAI token
 *     (the relay holds the key; the audio never passes through it)
 *   - the microphone is read at the device rate, downsampled to 16 kHz mono
 *     16-bit PCM, and streamed in 50 ms frames to AssemblyAI's streaming API
 *   - every byte sent is hashed as it goes, so the receipt names the exact
 *     audio that left, with its size and the transcript that came back
 *
 * Audio cannot be redacted. Everything said while listening is sent, and the
 * receipt says so. The transcript then goes through the normal gate, which
 * redacts it before the model sees it.
 */
import { sha256 as nobleSha256 } from '../vendor/noble-hashes/sha2.js';
import { bytesToHex } from '../vendor/noble-hashes/utils.js';
import { append, signDisclosure } from './ledger.js';
import { storeDisclosure, unwrapSecretKey } from './vault.js';
import { newId, scrub, sha256 } from './wcrypto.js';

export const VOICE_HOST = 'streaming.assemblyai.com';
export const VOICE_MODEL = 'universal-3-6-pro';
export const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 800; // 50 ms at 16 kHz

export const voiceUrl = (token) => `wss://${VOICE_HOST}/v3/ws?sample_rate=${SAMPLE_RATE}&format_turns=true&speech_model=${VOICE_MODEL}&token=${encodeURIComponent(token)}`;

/** Float samples at any rate to 16 kHz little-endian 16-bit PCM, by averaging each output sample's window. */
export function toPcm16(input, inRate) {
  const ratio = inRate / SAMPLE_RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b && j < input.length; j++) s += input[j];
    const v = Math.max(-1, Math.min(1, s / (b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** The microphone as a stream of Float32 blocks. Replaced in tests. */
export async function microphone() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const src = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'noai-pcm-tap');
  src.connect(tap);
  return {
    rate: ctx.sampleRate,
    onData(fn) {
      tap.port.onmessage = (e) => fn(e.data);
    },
    async close() {
      tap.port.onmessage = null;
      src.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await ctx.close();
    },
  };
}

export const httpToken = async (url) => {
  const res = await fetch(url, { method: 'POST' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `The voice token request failed with ${res.status}.`);
  return j.token;
};

/**
 * Start listening. Returns { stop }, where stop() ends the session and resolves
 * to what was heard and exactly what was sent.
 */
export async function listen({ tokenUrl = './api/voice-token', onPartial = () => {}, getToken = httpToken, openSocket = (u) => new WebSocket(u), source = microphone } = {}) {
  const token = await getToken(tokenUrl);
  const mic = await source();
  const ws = openSocket(voiceUrl(token));
  ws.binaryType = 'arraybuffer';
  const hash = nobleSha256.create();
  let bytes = 0;
  let pending = new Int16Array(0);
  const started = Date.now();
  const turns = new Map();
  let current = '';
  let open = false;
  let failed = null;

  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => {
      open = true;
      resolve();
    };
    ws.onerror = () => reject(new Error('Could not connect to the speech service.'));
  });
  const ended = new Promise((resolve) => {
    ws.onclose = () => resolve();
  });
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === 'Turn') {
      current = m.transcript ?? '';
      if (m.end_of_turn && m.turn_is_formatted) {
        turns.set(m.turn_order ?? turns.size, current);
        current = '';
      }
      onPartial([...turns.values(), current].filter(Boolean).join(' '));
    } else if (m.type === 'Termination') {
      ws.close();
    } else if (m.type === 'Error' || m.error) {
      failed = new Error(m.error ?? 'The speech service reported an error.');
    }
  };

  const send = (pcm) => {
    const buf = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    hash.update(buf);
    bytes += buf.length;
    ws.send(buf.slice().buffer);
  };
  mic.onData((block) => {
    if (!open) return;
    const pcm = toPcm16(block, mic.rate);
    const merged = new Int16Array(pending.length + pcm.length);
    merged.set(pending);
    merged.set(pcm, pending.length);
    let at = 0;
    while (merged.length - at >= FRAME_SAMPLES) {
      send(merged.subarray(at, at + FRAME_SAMPLES));
      at += FRAME_SAMPLES;
    }
    pending = merged.slice(at);
  });
  await opened;

  return {
    async stop() {
      await mic.close();
      if (pending.length && open) send(pending);
      pending = new Int16Array(0);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'Terminate' }));
      await Promise.race([ended, new Promise((r) => setTimeout(r, 4000))]);
      if (failed) throw failed;
      if (current) turns.set(Number.MAX_SAFE_INTEGER, current);
      const transcript = [...turns.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join(' ').trim();
      return { transcript, audioBytes: bytes, audioHash: bytesToHex(hash.digest()), seconds: (Date.now() - started) / 1000 };
    },
  };
}

/** Put the audio that left on the same signed chain as every model call. */
export async function receiptVoice(v, heard) {
  const receipt = {
    version: 1,
    kind: 'noai.disclosure',
    statement: 'This device streamed exactly the audio whose hash is below to the named speech-to-text service. Audio cannot be redacted: everything said while listening was sent.',
    receiptId: newId(),
    at: new Date().toISOString(),
    endpoint: VOICE_HOST,
    model: `assemblyai/${VOICE_MODEL}`,
    payloadHash: heard.audioHash,
    payloadBytes: heard.audioBytes,
    sources: [],
    redactions: {},
    responseHash: sha256(heard.transcript),
    usage: null,
    signer: v.data.device.publicKey,
  };
  const sk = await unwrapSecretKey(v);
  const signed = signDisclosure(receipt, sk);
  scrub(sk);
  const entry = await append(v.store, signed);
  await storeDisclosure(v, receipt.receiptId, `AUDIO\n${heard.audioBytes} bytes of 16 kHz mono speech, ${heard.seconds.toFixed(1)} s\n\nTRANSCRIPT RETURNED\n${heard.transcript}`);
  return { signed, entry };
}

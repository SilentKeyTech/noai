// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Voice: what the browser streams to AssemblyAI, what comes back, and the
 * receipt that records it. A stand-in socket plays AssemblyAI's side of the
 * v3 streaming protocol (Begin, Turn, Termination); the relay's token route is
 * tested with a stand-in for AssemblyAI's token endpoint.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { _resetLimits, voiceToken } from '../relay/core.mjs';
import { verifyLedger as nodeVerify } from '../src/ledger.ts';
import type { LedgerEntry, SignedDisclosure } from '../src/types.ts';
// @ts-expect-error plain JS module
import { exportFiles, readLedger, verifyLedger } from '../web/app/lib/ledger.js';
// @ts-expect-error plain JS module
import { memoryStore } from '../web/app/lib/store.js';
// @ts-expect-error plain JS module
import { createVault, readDisclosure } from '../web/app/lib/vault.js';
// @ts-expect-error plain JS module
import { listen, receiptVoice, toPcm16, voiceUrl } from '../web/app/lib/voice.js';

type Handler = ((e: { data: unknown }) => void) | null;

function fakeAssembly(turns: { text: string; final: boolean }[]) {
  const frames: Uint8Array[] = [];
  const texts: string[] = [];
  let url = '';
  const sock = {
    binaryType: '',
    readyState: 0,
    onopen: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onmessage: null as Handler,
    send(d: ArrayBuffer | string) {
      if (typeof d === 'string') {
        texts.push(d);
        if (JSON.parse(d).type === 'Terminate') {
          turns.forEach((t, i) => sock.onmessage?.({ data: JSON.stringify({ type: 'Turn', turn_order: i, transcript: t.text, end_of_turn: t.final, turn_is_formatted: t.final }) }));
          sock.onmessage?.({ data: JSON.stringify({ type: 'Termination', audio_duration_seconds: 1 }) });
        }
      } else frames.push(new Uint8Array(d));
    },
    close() {
      sock.readyState = 3;
      queueMicrotask(() => sock.onclose?.());
    },
  };
  const openSocket = (u: string) => {
    url = u;
    queueMicrotask(() => {
      sock.readyState = 1;
      sock.onopen?.();
      sock.onmessage?.({ data: JSON.stringify({ type: 'Begin', id: 's1', expires_at: 0 }) });
    });
    return sock;
  };
  return { openSocket, frames, texts, url: () => url };
}

function fakeMic(rate: number) {
  let push: ((b: Float32Array) => void) | null = null;
  let closed = false;
  return {
    source: async () => ({ rate, onData: (fn: (b: Float32Array) => void) => (push = fn), close: async () => void (closed = true) }),
    speak: (seconds: number) => {
      const block = 128;
      const total = Math.round(seconds * rate);
      for (let i = 0; i < total; i += block) push?.(new Float32Array(block).map((_, j) => 0.25 * Math.sin((i + j) / 20)));
    },
    closed: () => closed,
  };
}

describe('voice in the browser', () => {
  it('downsamples to 16 kHz 16-bit PCM', () => {
    const pcm = toPcm16(new Float32Array(4800).fill(0.5), 48000);
    assert.equal(pcm.length, 1600);
    assert.ok(pcm.every((s: number) => s > 16000 && s < 16400));
  });

  it('streams 50 ms frames with a one-minute token, and returns the formatted transcript', async () => {
    const as = fakeAssembly([
      { text: 'When is my dentist appointment?', final: true },
      { text: 'And who is it with?', final: true },
    ]);
    const mic = fakeMic(48000);
    const partials: string[] = [];
    const session = await listen({ getToken: async () => 'tok-123', openSocket: as.openSocket, source: mic.source, onPartial: (p: string) => partials.push(p) });
    mic.speak(1);
    const heard = await session.stop();
    assert.equal(as.url(), voiceUrl('tok-123'));
    assert.match(as.url(), /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?sample_rate=16000&format_turns=true&speech_model=universal-3-6-pro&token=tok-123$/);
    assert.equal(heard.transcript, 'When is my dentist appointment? And who is it with?');
    assert.ok(as.frames.slice(0, -1).every((f) => f.length === 1600), 'every full frame is 50 ms of 16-bit audio');
    const all = Buffer.concat(as.frames);
    assert.equal(heard.audioBytes, all.length);
    assert.equal(heard.audioHash, createHash('sha256').update(all).digest('hex'), 'the hash covers exactly the bytes sent');
    assert.ok(Math.abs(all.length - 32000) <= 1600, `about one second of audio, got ${all.length} bytes`);
    assert.deepEqual(as.texts, [JSON.stringify({ type: 'Terminate' })]);
    assert.ok(mic.closed());
    assert.equal(partials.at(-1), heard.transcript);
  });

  it('receipts the audio on the same chain, and the desktop verifier accepts it', async () => {
    const store = memoryStore();
    const v = await createVault(store, 'a passphrase for this test');
    const heard = { transcript: 'When is my dentist appointment?', audioBytes: 32000, audioHash: 'a'.repeat(64), seconds: 1 };
    const { signed } = await receiptVoice(v, heard);
    assert.equal(signed.receipt.endpoint, 'streaming.assemblyai.com');
    assert.equal(signed.receipt.payloadBytes, 32000);
    assert.match(signed.receipt.statement, /Audio cannot be redacted/);
    assert.deepEqual(signed.receipt.redactions, {});
    assert.equal((await verifyLedger(await readLedger(store), (await store.get('receipts')) ?? [])).valid, true);
    const files = await exportFiles(store);
    const parse = <T>(s: string): T[] => s.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
    const verdict = nodeVerify(parse<LedgerEntry>(files['ledger.jsonl']), parse<SignedDisclosure>(files['receipts.jsonl']));
    assert.equal(verdict.valid, true, verdict.reason);
    assert.match(await readDisclosure(v, signed.receipt.receiptId), /32000 bytes of 16 kHz mono speech[\s\S]*When is my dentist appointment\?/);
  });
});

describe('the relay mints voice tokens', () => {
  const req = (origin = 'https://noai.example') => new Request('https://noai.example/api/voice-token', { method: 'POST', headers: { origin } });

  it('returns a one-minute token for an allowed origin, without exposing the key', async () => {
    _resetLimits();
    const calls: { url: string; auth: string | undefined }[] = [];
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers.authorization });
      return new Response(JSON.stringify({ token: 'temp-abc' }), { status: 200 });
    };
    const res = await voiceToken(req(), { ASSEMBLYAI_API_KEY: 'real-key', NOAI_ALLOWED_ORIGINS: 'https://noai.example' }, fetchImpl);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(body).token, 'temp-abc');
    assert.ok(!body.includes('real-key'));
    assert.equal(calls[0]!.url, 'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60&max_session_duration_seconds=300');
    assert.equal(calls[0]!.auth, 'real-key');
  });

  it('refuses other origins, GET, and a relay with no key', async () => {
    _resetLimits();
    const never = async () => {
      throw new Error('should not be called');
    };
    assert.equal((await voiceToken(req('https://evil.example'), { ASSEMBLYAI_API_KEY: 'k', NOAI_ALLOWED_ORIGINS: 'https://noai.example' }, never)).status, 403);
    assert.equal((await voiceToken(new Request('https://noai.example/api/voice-token'), { ASSEMBLYAI_API_KEY: 'k' }, never)).status, 405);
    assert.equal((await voiceToken(req(), {}, never)).status, 503);
  });

  it('falls back to POST when the token endpoint refuses GET', async () => {
    _resetLimits();
    const methods: string[] = [];
    const fetchImpl = async (_u: string, init: { method: string }) => {
      methods.push(init.method);
      return init.method === 'GET' ? new Response('', { status: 405 }) : new Response(JSON.stringify({ token: 't' }), { status: 200 });
    };
    assert.equal((await voiceToken(req(), { ASSEMBLYAI_API_KEY: 'k' }, fetchImpl)).status, 200);
    assert.deepEqual(methods, ['GET', 'POST']);
  });
});

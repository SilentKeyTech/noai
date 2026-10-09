/**
 * The relay. It exists for one reason: a browser cannot hold the Nebius API
 * key, so something small has to add it. It is kept small enough to read in a
 * minute, because it is the one component the owner has to trust.
 *
 * What it does:
 *   - accepts one shape of request: a NOAI disclosure, with NOAI's own system
 *     prompt, an allowlisted Nemotron model and a bounded size, byte for byte
 *     as the gate writes it. Anything else is refused, so the key cannot be
 *     borrowed as a general purpose model proxy
 *   - forwards the exact bytes it received, unparsed and unchanged, so the
 *     sha256 on the owner's receipt is the sha256 of what reached Nebius
 *   - adds the key, and returns Nebius's reply as received
 *
 * What it never does: log, store or inspect a body beyond those checks. There
 * is no console call in this file, and a test fails the build if one appears.
 *
 * One handler for every host: Netlify functions, the local server in
 * relay/serve.mjs, and the container for Nebius Serverless.
 */
import { DEFAULT_MODEL, FAST_MODEL, SYSTEM } from '../src/prompt.ts';

export const UPSTREAM = 'https://api.tokenfactory.nebius.com/v1/chat/completions';
export const MAX_BODY_BYTES = 8000;
export const MAX_TOKENS = 4096;
const MODELS = new Set([DEFAULT_MODEL, FAST_MODEL]);

// Best effort per-client limit, per warm instance. The real ceiling is the
// spending cap on the Nebius key itself, which the README tells you to set.
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 30;
const hits = new Map();

function limited(client, now = Date.now()) {
  const recent = (hits.get(client) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(client, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > PER_WINDOW;
}

const reply = (status, error) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Returns null if the body is a well formed NOAI disclosure, or the reason it is not. */
export function refuse(body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return 'Not JSON.';
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'Not a NOAI disclosure.';
  if (!MODELS.has(j.model)) return 'Model not allowed.';
  if (!Number.isInteger(j.max_tokens) || j.max_tokens < 1 || j.max_tokens > MAX_TOKENS) return 'max_tokens out of range.';
  const m = j.messages;
  if (!Array.isArray(m) || m.length !== 2) return 'Expected exactly a system and a user message.';
  if (m[0]?.role !== 'system' || m[0]?.content !== SYSTEM) return 'Not a NOAI disclosure.';
  if (m[1]?.role !== 'user' || typeof m[1]?.content !== 'string' || !m[1].content.startsWith('PASSAGES\n')) return 'Not a NOAI disclosure.';
  const allowed = new Set(['model', 'max_tokens', 'temperature', 'messages']);
  if (Object.keys(j).some((k) => !allowed.has(k))) return 'Unexpected field.';
  // The gate writes the body with JSON.stringify (src/prompt.ts requestBody): these four
  // fields in this order, a numeric temperature, and role and content alone in each
  // message. The bytes must read back to themselves, so no repeated key, spacing or
  // escaping can mean one thing to this parser and another to the one upstream.
  if (Object.keys(j).join() !== 'model,max_tokens,temperature,messages' || typeof j.temperature !== 'number') return 'Not a NOAI disclosure.';
  if (m.some((x) => Object.keys(x).join() !== 'role,content')) return 'Not a NOAI disclosure.';
  if (JSON.stringify(j) !== body) return 'Not a NOAI disclosure.';
  return null;
}

export async function relay(request, env, fetchImpl = fetch) {
  if (request.method !== 'POST') return reply(405, 'POST only.');
  const origins = (env.NOAI_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  if (origins.length && !origins.includes(origin ?? '')) return reply(403, 'Origin not allowed.');
  if (!env.NEBIUS_API_KEY) return reply(503, 'The relay has no key configured.');

  const client = request.headers.get('x-nf-client-connection-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  if (limited(client)) return reply(429, 'Too many requests. Try again in a few minutes.');

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) return reply(413, `Over the ${MAX_BODY_BYTES} byte ceiling.`);
  const body = new TextDecoder().decode(bytes);
  const why = refuse(body);
  if (why) return reply(400, why);

  const upstream = await fetchImpl(UPSTREAM, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.NEBIUS_API_KEY}` },
    body: bytes,
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ---------------------------------------------------------------- voice

export const VOICE_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
export const VOICE_TOKEN_SECONDS = 60;
export const VOICE_SESSION_SECONDS = 300;

/**
 * Speech to text needs AssemblyAI's key, which a browser cannot hold either.
 * This mints a single-use streaming token that expires in a minute and allows
 * one session of at most five minutes. The audio itself never passes through
 * the relay: the browser streams it straight to AssemblyAI with the token, and
 * receipts it on the device.
 */
export async function voiceToken(request, env, fetchImpl = fetch) {
  if (request.method !== 'POST') return reply(405, 'POST only.');
  const origins = (env.NOAI_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  if (origins.length && !origins.includes(origin ?? '')) return reply(403, 'Origin not allowed.');
  if (!env.ASSEMBLYAI_API_KEY) return reply(503, 'Voice is not configured on this relay.');
  const client = request.headers.get('x-nf-client-connection-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  if (limited(`voice:${client}`)) return reply(429, 'Too many requests. Try again in a few minutes.');

  const url = `${VOICE_TOKEN_URL}?expires_in_seconds=${VOICE_TOKEN_SECONDS}&max_session_duration_seconds=${VOICE_SESSION_SECONDS}`;
  const headers = { authorization: env.ASSEMBLYAI_API_KEY };
  // AssemblyAI's docs show both GET and POST for this endpoint; try GET, then POST.
  let res = await fetchImpl(url, { method: 'GET', headers });
  if (res.status === 405 || res.status === 404) res = await fetchImpl(url, { method: 'POST', headers });
  const text = await res.text();
  if (!res.ok) return reply(502, `The speech service answered ${res.status}.`);
  let token;
  try {
    token = JSON.parse(text).token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || !token) return reply(502, 'The speech service returned no token.');
  return new Response(JSON.stringify({ token, expiresInSeconds: VOICE_TOKEN_SECONDS, maxSessionSeconds: VOICE_SESSION_SECONDS }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** For tests. */
export function _resetLimits() {
  hits.clear();
}

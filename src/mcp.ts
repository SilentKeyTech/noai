/**
 * NOAI as an MCP server, so a voice assistant such as Alexa+ can ask it things.
 *
 * The assistant on the other end is itself someone else's model. So a tool
 * result is a disclosure like any other, and gets the same treatment:
 *   - minimal: only the answer goes back, never the passages behind it
 *   - redacted: values stay as placeholders like [PHONE_1] unless the owner
 *     has allowed that kind for this client (NOAI_MCP_REVEAL=PHONE,EMAIL)
 *   - receipted: the exact result text is hashed, signed with the device key
 *     and chained into the same ledger as the Nemotron calls
 *
 * One question asked through Alexa+ therefore leaves two receipts: what
 * Nemotron saw, and what the assistant was handed. Tools that return nothing
 * from the vault (remember, verify) hand nothing over and leave no receipt.
 *
 * This file is the protocol only (JSON-RPC 2.0, MCP 2025-11-25). It never
 * touches the network; src/mcp-serve.ts carries it over Streamable HTTP.
 */
import { respond, sharedEmbedder } from './agent.ts';
import { newId, scrub, sha256 } from './crypto.ts';
import type { Embedder } from './embed.ts';
import { type AgentRequest, type ForwardOptions, forwardWithSecrets, type GateConfig, GateRefused, httpTransport, type Transport } from './gate.ts';
import { allSecretValues, listSecrets, placeholderFor, redactSecrets } from './secrets.ts';
import { append, readLedger, readReceipts, signDisclosure, verifyLedger } from './ledger.ts';
import { splitMemories } from './memory.ts';
import { redactAll, rehydrate } from './redact.ts';
import { splitReminders } from './skills.ts';
import type { DisclosureReceipt } from './types.ts';
import { type OpenVault, readNotes, storeDisclosure, unwrapPrivateKey } from './vault.ts';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

export interface McpContext {
  vault: OpenVault;
  cfg: GateConfig;
  /** placeholder kinds this client may receive as real values, e.g. ['PHONE'] */
  reveal: string[];
  transport?: Transport;
  embedder?: Embedder | null;
  /**
   * Which tools this server offers. 'notes' (the default) is the private memory,
   * 'vault' is the agent vault alone, for coding agents such as Claude Code,
   * 'all' is both.
   */
  toolset?: Toolset;
  /** how vault requests leave; tests pass a stand-in transport here */
  forward?: ForwardOptions;
}

export type Toolset = 'notes' | 'vault' | 'all';

/** Who is on the other end, from its initialize request. Named on every receipt. */
export interface McpSession {
  client: string;
  protocolVersion: string;
}

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Reply = { jsonrpc: '2.0'; id: string | number | null; result: unknown } | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

const ok = (id: Rpc['id'], result: unknown): Reply => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string): Reply => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

export const TOOLS = [
  {
    name: 'ask_noai',
    title: 'Ask NOAI',
    description:
      "Answer a question from the owner's private notes (their doctor, bills, family dates, contracts). Also drafts messages ('draft a message to ...'), sets reminders ('remind me to ... on 2026-10-12') and summarises bills. Private values come back as placeholders such as [PHONE_1] unless the owner allowed that kind; read placeholders out as 'your saved phone number' and never guess them.",
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: "The owner's words, as spoken." } },
      required: ['question'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'remember',
    title: 'Remember a fact',
    description: 'Seal a lasting fact about the owner into their vault, for example "my dentist is now Dr Rana". Sends nothing to any model.',
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'The fact, as one sentence.' } },
      required: ['fact'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'list_reminders',
    title: 'List reminders',
    description: "List the owner's upcoming reminders with their due dates. Private values stay as placeholders unless allowed.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'verify_disclosures',
    title: 'Verify what was disclosed',
    description: 'Check the signed disclosure log: how many times anything left the vault, to whom, how many bytes, and whether the chain is intact. Returns no vault content.',
    inputSchema: {
      type: 'object',
      properties: { last: { type: 'integer', minimum: 1, maximum: 20, description: 'How many recent disclosures to list. Default 5.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

export const VAULT_TOOLS = [
  {
    name: 'list_secrets',
    title: 'List vault secrets',
    description:
      "List the secrets in the owner's vault by name, with the hosts each may be sent to and where in a request it may go. Never returns a value. Use a secret by writing its placeholder, such as {{secret:github_token}}, in an http_request.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'http_request',
    title: 'HTTPS request using a vault secret',
    description:
      "Send one HTTPS request that needs a secret, without seeing the secret. Write {{secret:name}} where the value goes (for example the header Authorization: Bearer {{secret:github_token}}); write {{secret:name:base64}} for a file or a value the API wants base64 encoded. The owner's device inserts the real value as the request leaves, only for the hosts and parts of the request the owner allowed, and blanks any secret from the response before you see it. Redirects are not followed. Every call, sent or refused, is signed and logged on the owner's device.",
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'Default GET.' },
        url: { type: 'string', description: 'Full https URL. A placeholder may go in the path or query only if the owner allowed url for that secret.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers. Placeholders go in values, never in names.' },
        body: { type: 'string', description: 'Request body as text, for example JSON.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
] as const;

const NOTE_TOOLS = ['ask_noai', 'remember', 'list_reminders', 'verify_disclosures'];
const VAULT_ONLY = ['list_secrets', 'http_request', 'verify_disclosures'];

export function toolsFor(set: Toolset = 'notes') {
  const all = [...TOOLS, ...VAULT_TOOLS];
  const names = set === 'notes' ? NOTE_TOOLS : set === 'vault' ? VAULT_ONLY : [...NOTE_TOOLS, 'list_secrets', 'http_request'];
  return names.map((n) => all.find((t) => t.name === n) as (typeof all)[number]);
}

const VAULT_INSTRUCTIONS =
  "NOAI holds the owner's API keys and credentials so that you never see them. Call list_secrets to see what exists, then use http_request with a placeholder such as {{secret:github_token}} where the value belongs. Never ask the owner to paste a secret into the chat, and never try to print, echo or decode one: responses are scrubbed of secrets and every use is signed and logged on the owner's device.";

const INSTRUCTIONS =
  "NOAI is the owner's private memory. Use ask_noai for anything about their life that you do not already know. Answers may contain placeholders like [PHONE_1]: the real value is on the owner's device and was deliberately withheld from you, so say 'your saved number' rather than guessing. Every answer handed to you is signed and logged on the owner's device.";

/** Placeholders that stay placeholders for this client, counted by kind for the receipt. */
function withheld(t: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of t.matchAll(/\[([A-Z]+)_\d+\]/g)) counts[m[1] as string] = (counts[m[1] as string] ?? 0) + 1;
  return counts;
}

/** No tool hands a vault secret to a client, even one the owner pasted into a note by mistake. */
export function scrubSecrets(v: OpenVault, t: string): string {
  const all = allSecretValues(v);
  if (!all.length) return t;
  const out = redactSecrets(t, all).text;
  for (const s of all) scrub(s.value);
  return out;
}

/** Restore only the kinds the owner allowed for MCP clients. */
export function revealOnly(raw: string, restore: Map<string, string>, kinds: string[]): string {
  const allowed = new Map([...restore].filter(([ph]) => kinds.includes(ph.slice(1).replace(/_\d+\]$/, ''))));
  return rehydrate(raw, allowed);
}

/**
 * Sign and chain what is about to be handed to the MCP client. Same receipt
 * kind, same chain, same verifier as a Nemotron call: the endpoint says "mcp"
 * and the model field names the client.
 */
export async function receiptHandover(
  v: OpenVault,
  root: string,
  client: string,
  handed: string,
  sources: DisclosureReceipt['sources'],
): Promise<{ receipt: DisclosureReceipt; seq: number }> {
  const receipt: DisclosureReceipt = {
    version: 1,
    kind: 'noai.disclosure',
    statement: 'This device handed exactly the tool result whose hash is below, and nothing else, to the named MCP client.',
    receiptId: newId(),
    at: new Date().toISOString(),
    endpoint: 'mcp',
    model: `mcp:${client}`,
    payloadHash: sha256(handed),
    payloadBytes: Buffer.byteLength(handed, 'utf8'),
    sources,
    // Here the counts are what was withheld from the client, not what was replaced for the model.
    redactions: withheld(handed),
    responseHash: sha256(''),
    usage: null,
    signer: v.data.device.publicKey,
  };
  const pk = unwrapPrivateKey(v);
  const signed = signDisclosure(receipt, pk);
  scrub(pk);
  const entry = await append(root, signed);
  await storeDisclosure(v, receipt.receiptId, handed);
  return { receipt, seq: entry.seq };
}

async function callTool(ctx: McpContext, session: McpSession, name: string, args: Record<string, unknown>) {
  const root = ctx.cfg.root;
  if (!toolsFor(ctx.toolset).some((t) => t.name === name)) return null;
  switch (name) {
    case 'list_secrets': {
      const secrets = listSecrets(ctx.vault).map((s) => ({
        name: s.name,
        placeholder: placeholderFor(s.name, s.kind === 'file' ? 'base64' : undefined),
        kind: s.kind,
        ...(s.fileName ? { fileName: s.fileName } : {}),
        bytes: s.bytes,
        hosts: s.hosts,
        allowedIn: s.placements,
      }));
      if (!secrets.length) return text('The vault holds no secrets yet. The owner adds them on their own machine with: npm run vault -- add <name> --host <host>');
      const lines = secrets.map((s) => `${s.placeholder}  ${s.kind}${s.fileName ? ` ${s.fileName}` : ''}, to ${s.hosts.join(', ')}, in ${s.allowedIn.join(', ')}`);
      return { ...text(lines.join('\n')), structuredContent: { secrets } };
    }
    case 'http_request': {
      const req: AgentRequest = {
        url: typeof args.url === 'string' ? args.url : '',
        ...(typeof args.method === 'string' ? { method: args.method } : {}),
        ...(args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers) ? { headers: Object.fromEntries(Object.entries(args.headers as Record<string, unknown>).map(([k, val]) => [k, String(val)])) } : {}),
        ...(typeof args.body === 'string' ? { body: args.body } : {}),
      };
      const r = await forwardWithSecrets(ctx.vault, root, session.client, req, ctx.forward);
      return {
        ...text(r.handed, r.outcome !== 'sent'),
        structuredContent: { outcome: r.outcome, status: r.status, receipt: r.seq, echoesRedacted: r.receipt?.echoesRedacted ?? 0 },
      };
    }
    case 'ask_noai': {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (!question) return text('Ask something.', true);
      const r = await respond(ctx.vault, ctx.cfg, question, ctx.transport ?? httpTransport, ctx.embedder === undefined ? await sharedEmbedder() : ctx.embedder);
      if (r.kind === 'memory') return text('Saved in the vault. Nothing was sent to any model.');
      // Start from what the model said, placeholders intact, and drop the lines meant for the device.
      // Citations like [P1] point at passages the assistant never sees, so they go too.
      const spoken = splitMemories(splitReminders(r.rawAnswer).answer).answer.replace(/\s*\(?\[P\d+\](?:,\s*\[P\d+\])*\)?/g, '');
      const handed = scrubSecrets(ctx.vault, revealOnly(spoken, r.restore, ctx.reveal));
      const handover = await receiptHandover(ctx.vault, root, session.client, handed, r.signed.receipt.sources);
      const notes = [
        r.reminders.length ? `Reminder set for ${r.reminders.map((n) => n.title).join(', ')}.` : '',
        r.remembered.length ? 'Saved a new fact in the vault.' : '',
      ].filter(Boolean);
      return {
        ...text([handed, ...notes].join('\n\n')),
        structuredContent: {
          answer: handed,
          passagesUsed: r.used,
          withheld: handover.receipt.redactions,
          receipts: { model: r.entry.seq, handover: handover.seq },
        },
      };
    }
    case 'remember': {
      const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
      if (fact.length < 3) return text('Nothing to remember.', true);
      const r = await respond(ctx.vault, ctx.cfg, `remember that ${fact.replace(/\?+$/, '')}`, ctx.transport ?? httpTransport, null);
      return text(r.kind === 'memory' ? 'Saved in the vault. Nothing was sent to any model.' : 'Nothing to remember.', r.kind !== 'memory');
    }
    case 'list_reminders': {
      const today = new Date().toISOString().slice(0, 10);
      const due = readNotes(ctx.vault)
        .filter((n) => n.kind === 'reminder' && n.title >= today)
        .sort((a, b) => a.title.localeCompare(b.title));
      if (!due.length) return text('No upcoming reminders.');
      // The vault holds real values; the client gets the same redaction the model would.
      const red = redactAll(due.map((n) => `${n.title}: ${n.body}`));
      const handed = scrubSecrets(ctx.vault, revealOnly(red.texts.join('\n'), red.map, ctx.reveal));
      await receiptHandover(ctx.vault, root, session.client, handed, due.map((n) => ({ noteId: n.id, chunk: 0, chunkHash: sha256(n.body) })));
      return text(handed);
    }
    case 'verify_disclosures': {
      const last = Math.min(20, Math.max(1, Number(args.last ?? 5) || 5));
      const entries = await readLedger(root);
      const verdict = verifyLedger(entries, await readReceipts(root));
      const recent = entries.slice(-last).map((e) => `#${String(e.seq)} ${e.at.slice(0, 16).replace('T', ' ')} to ${e.model}, ${String(e.payloadBytes)} bytes`);
      return {
        ...text([`${verdict.valid ? 'Intact' : 'BROKEN'}: ${verdict.reason}`, ...recent].join('\n'), !verdict.valid),
        structuredContent: { valid: verdict.valid, length: verdict.length, brokenAt: verdict.brokenAt, reason: verdict.reason },
      };
    }
    default:
      return null;
  }
}

/**
 * Handle one JSON-RPC message. Returns null for notifications, which get no reply.
 * `session` is null until initialize has run; the transport creates it.
 */
export async function handleRpc(ctx: McpContext, session: McpSession | null, msg: unknown): Promise<Reply | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || (msg as Rpc).jsonrpc !== '2.0') return fail(null, -32600, 'Invalid request.');
  const { id, method, params = {} } = msg as Rpc;
  const isNotification = id === undefined;
  if (typeof method !== 'string') return isNotification ? null : fail(id, -32600, 'Invalid request.');
  if (isNotification) return null;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL;
      return ok(id, {
        protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'noai', title: 'NOAI', version: '0.4.0' },
        instructions: ctx.toolset === 'vault' ? VAULT_INSTRUCTIONS : ctx.toolset === 'all' ? `${INSTRUCTIONS} ${VAULT_INSTRUCTIONS}` : INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: toolsFor(ctx.toolset) });
    case 'tools/call': {
      if (!session) return fail(id, -32600, 'Initialize first.');
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = await callTool(ctx, session, name, args);
        return result ? ok(id, result) : fail(id, -32602, `Unknown tool: ${name}`);
      } catch (e) {
        // A refusal or a model failure is a tool result the assistant can read out, not a protocol error.
        const why = e instanceof Error ? e.message : String(e);
        return ok(id, text(e instanceof GateRefused ? why : `NOAI could not answer: ${why}`, true));
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

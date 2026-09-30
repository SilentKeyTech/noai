# NOAI

Pronounced No Eye. A personal AI that answers questions about your private life without the model ever seeing it.

**Live demo (fictional data):** https://noai-silentkey.netlify.app

Built for the Nebius x NVIDIA Global AI Hackathon, Personal AI track, by Silent Key Technologies. Runs on **NVIDIA Nemotron 3 Super** served by **Nebius Token Factory**.

## The problem

A personal assistant is only useful if it knows your life: your health notes, your bank details, your family, your contracts. Today that means shipping all of it to someone else's model and trusting a privacy policy. You cannot see what was sent, and you cannot prove it afterwards.

## How NOAI works

```
 your notes ──► sealed vault (AES-256-GCM, key from your passphrase, on device)
                      │
 question ──► on-device retrieval (BM25 + MiniLM embeddings as WASM, nothing hosted)
                      │  picks the smallest set of relevant passages
                      ▼
               EGRESS GATE  (src/gate.ts, the only file allowed to use the network)
                 1. redact    names, emails, phones, IDs, IBANs, cards, keys become [PERSON_1] etc.
                 2. budget    refuse anything over the byte ceiling
                 3. hash      sha256 of the exact bytes about to leave
                 4. send  ──► NVIDIA Nemotron 3 Super on Nebius Token Factory
                 5. receipt   Ed25519 signed, hash chained, sealed copy kept locally
                 6. rehydrate placeholders back to real values, on device
                      │
                      ▼
 answer with your real data ◄── the model only ever saw placeholders
```

The demo is a split screen. On the left, you ask and get an answer. On the right, a live receipt tape shows every disclosure: how many bytes left, which passages, what was redacted, and exactly what the model saw. Press **Tamper with the log** and chain verification turns red, naming the entry that was edited.

## In the browser

`web/app` is the same product running entirely in a browser tab: the vault in IndexedDB, AES-256-GCM through WebCrypto, scrypt and Ed25519 from the audited noble libraries, and the embedding model as WebAssembly. Ranking, redaction and the prompt come from the same `src/` modules the tests prove, transpiled rather than rewritten, so what leaves the browser is byte for byte what the desktop would send (test: `sends only redacted text through the relay, and the receipt verifies with the desktop verifier`).

A browser cannot hold an API key, so a relay adds it. The relay (`relay/core.mjs`, one short file) is the one component you have to trust, and it is built to be boring:

- it forwards the exact bytes it received, so the hash on your receipt is the hash of what reached Nebius
- it accepts only a NOAI disclosure: NOAI's own system prompt, an allowlisted Nemotron model, a bounded size. Anything else is refused, so the key cannot be borrowed as a general model proxy
- it logs nothing, and a test fails the build if a logging call appears in it

Receipts downloaded from the browser verify offline with `noai verify`, with no browser involved.

```bash
npm run build:web               # transpile the shared core, vendor the libraries, copy the model
npm run web                     # the browser demo and its relay on http://127.0.0.1:7791
```

Hosting: `netlify.toml` publishes `web/app` with the relay as a function at `/api/chat` and a strict Content Security Policy (no third-party script, style or connection). `relay/Dockerfile` runs the relay alone for Nebius Serverless. Either way, give it a dedicated Nebius key with a spending cap, and set `NOAI_ALLOWED_ORIGINS` to the demo's own origin. The relay's per-client limit is best effort; the cap on the key is the real ceiling.

## Skills

Three reusable skills run through the same gate, redaction and receipts as any question: **draft a message**, **set a reminder** and **summarise a bill**. A skill adds a task line to the question and never changes the system prompt, so the relay's check still holds. A bill summary sends the bill with its IBAN replaced and none of your notes. A reminder comes back with a date, has its real values put back on the device, and is sealed into the vault.

If Nemotron 3 Super does not answer in time, or returns 429 or a 5xx, the same redacted passages go once to Nemotron 3 Nano. Every attempt that sent bytes is receipted, answered or not.

## Import

A vault is only useful with your life in it, so NOAI reads the files you already have, on the device: a **WhatsApp chat export** (Android or iPhone, English or Arabic, one note per day of conversation), **.txt and .md** files (one note per heading), and **PDFs** with a text layer, including Arabic PDFs drawn one glyph at a time, which are put back in reading order. Importing sends nothing and writes no receipt, and importing the same file twice adds nothing. A scanned PDF with no text layer is refused with a plain message; text recognition is not built yet.

```bash
npm run noai -- import "WhatsApp Chat with Sami.txt" lease.pdf notes.md
```

In the browser, **+ Import files** under the vault does the same in the tab. pdf.js is vendored and served from the same origin; it is given the bytes, never a URL.

## Memory

Start a message with "remember that" and NOAI keeps the fact in the sealed vault. That never calls the model, so it writes no receipt: nothing left.

The model can also keep things. If your question tells it something new ("Sami has a new number now, ..."), it ends its reply with a `REMEMBER:` line. It only ever saw `[PHONE_1]`, so the device swaps the real number back in before sealing the memory. Every memory shows in the vault list and can be forgotten, which deletes the sealed entry rather than hiding it.

## Voice assistants and agents (MCP)

NOAI also runs as a self-hosted MCP server, so Alexa+ or any assistant that speaks the Model Context Protocol (2025-11-25, Streamable HTTP) can ask it things. The assistant is someone else's model too, so NOAI treats every tool result as a disclosure:

- **Minimal.** The assistant gets the answer, never the passages behind it. Citations like `[P1]` are removed because they point at text it never sees.
- **Redacted.** Private values stay placeholders such as `[PHONE_1]`. The owner can allow a kind for assistants with `NOAI_MCP_REVEAL=PHONE`; everything else stays on the device.
- **Receipted.** The exact result text is hashed, signed with the device key and chained into the same ledger as the Nemotron calls, naming the client. One spoken question leaves two receipts: what Nemotron saw, and what the assistant was handed.

Four tools: `ask_noai` (questions, drafts, reminders, bill summaries), `remember` (sends nothing, writes no receipt), `list_reminders` and `verify_disclosures` (returns the chain verdict, no vault content).

```bash
export NOAI_PASSPHRASE='your passphrase'
export NOAI_MCP_TOKEN="$(node -e "console.log(crypto.randomBytes(24).toString('base64url'))")"
npm run mcp                     # http://127.0.0.1:7792/mcp
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:7792/mcp --transport http \
  --header "Authorization: Bearer $NOAI_MCP_TOKEN" --method tools/list
```

The server listens on 127.0.0.1 by default and every request needs the bearer token. An `Origin` header is refused unless listed in `NOAI_MCP_ALLOWED_ORIGINS`. To reach it from a hosted assistant, put it behind an HTTPS tunnel you control (`NOAI_MCP_HOST`, `NOAI_MCP_PORT`); the vault, the keys and the ledger stay on your machine.

## What is proven, and what is not

Proven by the code and the tests:

- The vault file contains no readable note text (test: `vault stores nothing readable on disk`).
- Only `src/gate.ts` can reach the network. A test scans every other source file and fails the build if one calls `fetch`, `https`, `net` or sockets.
- The receipt hash equals the sha256 of the exact request body sent (test: `the receipt hash matches the exact bytes sent`).
- Redacted values never appear in the outbound body (same test). A name is hidden everywhere in one disclosure under one placeholder, so the question and the passages agree (test: `hides a name everywhere in one disclosure, under one placeholder, even when written short`).
- Editing or deleting any ledger entry breaks verification at that entry (tests: `the ledger`).
- Verification needs only `receipts.jsonl` and `ledger.jsonl`. No vault, no account, no network.
- Retrieval understands meaning, on device: "who is my doctor?" finds the note that says GP, which BM25 alone misses (test: `hybrid finds the GP for "doctor", and sends nothing from other notes`).
- The embedding model is checked against a pinned SHA-256 before it runs, and refused if it does not match (test: `refuses a model file that does not match its pinned hash`).
- Saving a memory sends nothing and writes no receipt (test: `saving a memory sends nothing, writes no ledger entry, and seals it`).
- An MCP client receives the answer only, with private values still placeholders, and the handover is signed into the same chain as the model call (tests: `test/mcp.test.ts`).
- When the model asks to remember something, it only ever saw placeholders. The real values are put back and sealed on device (test: `keeps what the model asks to remember, with the real values put back on device`).

The privacy claims each have their own test, including three that prove what NOAI does **not** hide: `node --test test/claims.test.ts`.

Not proven, stated plainly:

- A receipt is a signed statement by your device. It proves what your device sent and that the record was not altered afterwards. It cannot prove what the provider does with a request once it arrives.
- Semantic retrieval is looser than keyword retrieval. Asked "who is my doctor?", the demo sends the GP line, the dentist memory and the allergy line from the same health note. Nothing from money, family or travel goes out, but the allergy line is a near miss the tape shows plainly.
- Through a voice assistant, the assistant's provider already hears the spoken question and receives the answer it is handed. NOAI limits and records that handover; it cannot limit what the assistant does with it. Any kind allowed in `NOAI_MCP_REVEAL` is handed over in the clear.
- The redactor runs on the device with no model. It catches structured identifiers (emails, phone numbers, Saudi national ID and Iqama numbers, passport numbers, IBANs, card numbers, API keys, IP addresses, in Latin or Arabic digits) and names of people in English or Arabic when they are on its list of given names, follow a title or relation ("Dr.", "my brother", "السيد", "أخي") or were given to it by the owner. A name that is also a common word ("Grace from HR"), or an unusual name with nothing pointing at it, is sent as written. Dates and free text are sent. The passages it sends are the minimum needed, and the tape shows every word of them.

## Run it

Requires Node 22.18 or later. One runtime dependency, onnxruntime-web, which runs the embedding model as WebAssembly with no native code. Without the model NOAI falls back to BM25 alone and says so.

```bash
git clone https://github.com/SilentKeyTech/noai && cd noai
npm install                     # onnxruntime-web, plus typescript for dev
npm run model                   # one time: fetch the 23 MB embedding model, hash checked
echo NEBIUS_API_KEY=your_key > .env
npm test                        # 69 tests, no network
npm run serve                   # http://127.0.0.1:7788
```

In the browser, choose a passphrase to create the vault, then add notes. To load the demo notes (a fictional person) from the command line instead:

```bash
export NOAI_PASSPHRASE='pick one'
npm run noai -- init
npm run noai -- seed
npm run noai -- ask "When is my brother's birthday and what is his number?"
npm run noai -- verify
```

Configuration, all optional: `NOAI_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`), `NOAI_MAX_PAYLOAD` bytes (default 8000), `NOAI_MAX_TOKENS` (default 4096), `NOAI_HOME` (default `./.noai`), `NOAI_PORT` (default 7788).

## How we used Nebius and NVIDIA

- **NVIDIA Nemotron 3 Super 120B** (`nvidia/nemotron-3-super-120b-a12b`) answers every question. We picked it after benchmarking the four Nemotron tiers on Token Factory: it passed every case in about one second at about USD 0.0001 per answer. Nemotron 3 Nano 30B is the tested fast fallback.
- **Nebius Token Factory** serves the model through an OpenAI compatible endpoint, so the gate is one plain `fetch` with no SDK, which keeps the network surface small enough to audit in one file.
- **Deliberately not used:** the hosted embedding model. Embedding your notes on a server would disclose all of them, so retrieval stays on device.

Our honest feedback on both is in [FEEDBACK.md](FEEDBACK.md).

## Built on BurnKey

`src/crypto.ts` is byte identical to the crypto module of BurnKey, Silent Key's key destruction product, and a test checks this. NOAI uses the same vault layout (scrypt to a key encryption key, a random master key, AES-256-GCM), the same Ed25519 signing and the same canonical JSON. BurnKey proves a file was destroyed. NOAI proves what was disclosed.

## License

Apache 2.0. See [LICENSE](LICENSE).

## Built before the hackathon

One file: `src/crypto.ts` is shared byte for byte with BurnKey, another Silent Key Technologies product, where it was first committed on 1 September 2026. A test checks the two copies are identical. Everything else was written for this hackathon, from the first commit on 20 September 2026.

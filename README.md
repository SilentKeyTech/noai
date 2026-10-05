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

## Voice

Press **Speak**, ask out loud, press **Stop**. The microphone is read in the tab, downsampled to 16 kHz mono PCM and streamed in 50 ms frames to [AssemblyAI's streaming speech-to-text](https://www.assemblyai.com/docs/streaming/getting-started/transcribe-streaming-audio) (Universal-3 Pro). The formatted transcript becomes the question and goes through the gate like any typed one, so the model sees it redacted. The answer is read aloud only by a voice that runs on the device; if the browser has none, it is not read aloud.

Audio is a disclosure, so it is receipted on the same chain: the receipt carries the SHA-256 of exactly the audio bytes that were streamed, their size, the endpoint and the hash of the transcript that came back. Audio cannot be redacted, and the receipt says so: everything said while listening is sent. The AssemblyAI key stays on the relay (`/api/voice-token`), which mints a one-minute, single-session token; the audio goes from the browser straight to AssemblyAI and never through the relay. `web/app/lib/voice.js` is the second of exactly two files in the browser build that send anything, and a test holds it to that one destination. Set `ASSEMBLYAI_API_KEY` on the relay to turn voice on.

The voice files are licensed MIT OR Apache-2.0.

## Import

A vault is only useful with your life in it, so NOAI reads the files you already have, on the device: a **WhatsApp chat export** (Android or iPhone, English or Arabic, one note per day of conversation), **.txt and .md** files (one note per heading), and **PDFs** with a text layer, including Arabic PDFs drawn one glyph at a time, which are put back in reading order. Importing sends nothing and writes no receipt, and importing the same file twice adds nothing. A scanned PDF with no text layer is refused with a plain message; text recognition is not built yet.

**Contacts (.vcf)** from a phone or Google Contacts become one note per person, including Android exports where Arabic names are stored encoded. Every name in them is then hidden in every disclosure (see [Names](#names)).

```bash
npm run noai -- import "WhatsApp Chat with Sami.txt" lease.pdf notes.md contacts.vcf
npm run noai -- people          # list, on this machine, every name that will always be hidden
```

In the browser, **+ Import files** under the vault does the same in the tab, with the same parser. pdf.js is vendored and served from the same origin; it is given the bytes, never a URL. The browser file picker does not offer .vcf files yet; contacts import is in the command line for now.

## Names

Names of people are hidden on the device as `[PERSON_1]`, `[PERSON_2]` and put back on the device when the answer comes in, exactly like phone numbers. There is no model involved: a fixed list of common English and Arabic given names, cue words ("Dr.", "my brother", "السيد", "أخي"), name chains ("bin", "Al-", "أبو", "عبد"), and the vault itself.

Before every disclosure NOAI reads the whole vault on the device and collects every person it names: names the rules above find in any note, the people who wrote in an imported WhatsApp chat, and imported contacts. Those names are hidden in whatever is sent, even in a passage where nothing points at them. So "My accountant is Zorbek Tamarind" in one note means "Zorbek paid the deposit" in another goes out as "[PERSON_1] paid the deposit". The list is rebuilt for each question and never stored or sent.

Spellings count as one person. For about forty common Arabic names, the usual English spellings and short forms and the Arabic script are one name: Mohd, Mhmd, Mohmd, Mhd, Mohammed, Muhammad and محمد all become the same `[PERSON_1]`, and each of them is hidden even when nothing points at it. For anyone else, teach it in a note or a memory, in English or Arabic, and both names are hidden as one person:

```text
remember that Hamoudi is short for Mohammed Haddad
remember that Zizou is a nickname for Ziad Karam
حمودي اختصار لمحمد
```

A nickname saved on an imported contact works the same way. `noai people` lists what it has learned.

Two things a known name does not swallow: a place named after a person ("King Fahd Road", "مستشفى الملك فيصل") stays as written, and a contact called Will or May hides the full name but not the everyday word "will" or "may".

What it does not do, stated plainly:

- A name that no note points at, that is not a common given name, and that is not in your imported contacts is sent as written (test: `LIMIT: a name the vault never points at and no contact holds still leaves the device`).
- It can hide too much. A contact called Grace also hides "grace" in "the grace period", and a word wrongly taken for a name after a cue ("my boss Approved") is hidden everywhere in the vault after that. Over-hiding costs answer quality, not privacy.
- A spelling that is not in its built-in list and that you have not taught it is a different name. A typo ("Mohamemd") is not recognised.
- Built-in spellings are joined by name, not by person: two different people called Mohd and Mohammed with no family name share one placeholder.
- It hides who, and some of the most personal what: where someone lives, a full date of birth, and a list of medical terms (tests: `test/kinds.test.ts`).
  - Addresses: a Saudi National Address code, a numbered street ("221 Olaya Main Street"), and whatever follows "my address is", "lives at", a P.O. box or postal code, العنوان, ص.ب, الرمز البريدي. A landmark such as "King Fahd Road" is not an address and stays.
  - Dates of birth: a full date with a year, written after "born", "date of birth", "DOB" or تاريخ الميلاد. A birthday with no year and an ordinary date stay readable, because reminders need them.
  - Medical: about 35 English and 15 Arabic terms (diabetes, cancer, HIV, asthma, pregnancy, insulin, السكري, سرطان and so on). It is a list, so a condition or drug not on it is sent as written. It cannot judge context: "cancer" in a horoscope is hidden too.
  - Everything else that describes a person ("the tall man from the bank"), places that are not an address, amounts and ordinary dates are sent.
  - Not done: reading scanned PDFs and photos (OCR). Text in an image is neither read nor hidden.

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

## Company gateway

A company's staff keep using the AI tool they already use. The tool points at NOAI instead of the AI provider. NOAI hides private data on the company's own machine, forwards the call, signs a receipt, and puts the real values back in the answer.

It is an OpenAI-compatible endpoint (`POST /v1/chat/completions`, `GET /v1/models`), so anything that lets you set a base URL works: Open WebUI, LibreChat, Continue, scripts, the OpenAI SDKs.

```bash
export NOAI_PASSPHRASE='your passphrase'
export NOAI_GATEWAY_TOKENS="amal:$(node -e "console.log(crypto.randomBytes(24).toString('base64url'))"),omar:..."
export NEBIUS_API_KEY=...        # or NOAI_GATEWAY_KEY, with NOAI_GATEWAY_UPSTREAM for another OpenAI-compatible provider
npm run gateway                  # http://127.0.0.1:7794/v1
```

Each staff member gets their own token (24 characters or more) and uses it as the API key. Every receipt names who made the call, never the token. The gateway listens on 127.0.0.1 unless `NOAI_GATEWAY_HOST` and `NOAI_GATEWAY_PORT` say otherwise; an `Origin` header is refused unless listed in `NOAI_GATEWAY_ALLOWED_ORIGINS`. Other settings: `NOAI_GATEWAY_MODELS` (extra model ids to list), `NOAI_GATEWAY_MAX_PAYLOAD` (bytes, default 200000), `NOAI_GATEWAY_TIMEOUT_MS`.

What it does to every call, in this order: hide private values in every message (one placeholder space per request, plus every person the vault names), refuse anything over the byte ceiling, hash the exact body, send it, sign and chain a receipt (the redacted body is kept sealed in the vault), put the real values back in the reply.

Limits, stated plainly:

- The AI provider still sees the redacted text. Dates, amounts and free text that are not a recognised kind are sent as written. NOAI hides what it recognises; it does not make data anonymous and does not make a company compliant.
- The ChatGPT and Copilot apps cannot be pointed at a different address, so they cannot use the gateway.
- Text only. Images, audio, files, tool calls and function calls are refused, because they can carry private data the gateway cannot hide. Nothing is sent when it refuses.
- Only settings that carry no text are forwarded (temperature, top_p, max_tokens, stop, n, seed, penalties). Anything else the client sends, such as `user` or `metadata`, is dropped.
- Streaming is real: words arrive as the provider writes them, with the real values put back in each piece. A placeholder cut in two by the network is held back until it is whole. The receipt is written when the stream ends. If a stream breaks part way, the client gets an error event and the call is receipted as an error.
- Tokens do not expire. Revoke a person and their token stops on their next call. There is no single sign-on, no email invite and no per-person spending limit yet.

### A chat page, nothing else to install

Staff who have no AI tool of their own open `http://127.0.0.1:7794/chat`, paste their token, and chat. It streams, shows the model list, and under each answer says which kinds of value were hidden and the receipt number. History lives only in the browser tab. Text only. It is a plain page served by the gateway: no Docker, no Python, no account.

If the company would rather use Open WebUI or LibreChat, point either at `http://<gateway>:7794/v1` with the staff member's token as the API key; see `docs/open-webui.md`. That route has not been tested here.

### People and the receipts page

Add people on the machine that runs the gateway. A token is printed once and not stored; `staff.json` beside the vault holds only hashes.

```bash
export NOAI_ADMIN_PASSWORD='at least 12 characters'
npm run staff -- add ramzi --admin     # may read the receipts page
npm run staff -- add amal              # may use the gateway
npm run staff -- list
npm run staff -- revoke amal
```

The receipts page is `http://127.0.0.1:7794/admin`. An admin signs in with name and password and sees: whether the chain is intact (red and the entry number if anything was edited), calls, bytes and hidden values per person, and the latest 200 calls. "Read what was sent" shows the redacted text that left, never the real values. Admins can revoke people; nobody can revoke themselves. Five wrong passwords lock that name for five minutes. The session cookie is HttpOnly and SameSite=Strict, the page refuses any Host that is not the machine's own (DNS rebinding), and it puts server text on the screen as text only. A staff token cannot read receipts.

Tests: `test/staff.test.ts`.

Tests: `test/gateway.test.ts` (names, phones and IDs never reach the provider; the receipt hash equals the sha256 of the body sent; a bad token gets 401; refused requests send nothing; concurrent calls keep the chain valid).

## Agent vault: keys your AI agents use without seeing them

Coding agents such as Claude Code need API keys to do real work. Pasting a key into the chat puts it in the agent's context, its logs and its model provider's servers. NOAI's agent vault keeps the key on your machine instead:

- **The agent only holds a placeholder.** It writes `Authorization: Bearer {{secret:github_token}}`. `src/gate.ts`, still the only file that can reach the network, swaps in the real value as the request leaves. It does this only over HTTPS, only to the exact hosts you allowed for that secret, and only in the part of the request you allowed (header by default). Anything else is refused and nothing is sent.
- **Secrets are blanked out of what comes back.** If a response or an error message contains any vault secret (as it is, base64, URL-encoded, hex or JSON-escaped, even when the response is cut off in the middle of it), the agent sees the placeholder instead. The same applies to the notes tools and to anything sent to the model.
- **Every use is receipted.** Each request that names a secret, sent or refused, gets an Ed25519-signed receipt on the same hash chain as the disclosures. It records which secret, which host and path, when, which MCP client asked and how it ended. The receipt never holds the value, or a hash of anything that contains it. `npm run vault -- verify` checks the chain offline and tells you which key signed it.
- **Local, no account.** Secrets are sealed in the same AES-256-GCM vault as the notes. Text values and small files such as an Android `.jks` are both supported.

```bash
npm run vault -- init
npm run vault -- add github_token --host api.github.com      # value typed hidden, never on the command line
npm run vault -- serve                                        # prints the one-line `claude mcp add` command
npm run vault -- receipts
npm run vault -- verify --expect <device key>
```

Five-minute setup for Claude Code on Windows: [docs/agent-vault.md](docs/agent-vault.md) (in Arabic: [docs/agent-vault.ar.md](docs/agent-vault.ar.md)). Release signing without the keystore sitting on disk: `npm run vault -- run --file KEYSTORE=... --env STORE_PASSWORD=... -- .\gradlew.bat bundleRelease`, see step 7 of the guide.

**First use: Silent Key's own release keys.** Silent Key Technologies signs its Android apps with a Play upload keystore and uses API tokens for GitHub and the Play Developer API. The plan is for those to live in the agent vault, so the agents that help with releases call the APIs by placeholder and never read the keys. The tests rehearse that setup with test values only: a stand-in `.jks`, a GitHub token and a Play access token. No real Silent Key key has been imported.

Limits: the vault keeps keys out of the agent's context, but it is not a security boundary between programs running as the same Windows user. An allowed host that stores what it is sent could be used to leak a secret placed in the body, which is why body placement is off by default. Receipts prove what your device sent or refused, not what the API did with it. The vault has not had an independent security review. The full list is in [docs/agent-vault.md](docs/agent-vault.md#limits-stated-plainly).

## What is proven, and what is not

Proven by the code and the tests:

- The vault file contains no readable note text (test: `vault stores nothing readable on disk`).
- Only `src/gate.ts` can reach the network. A test scans every other source file and fails the build if one calls `fetch`, `https`, `net` or sockets.
- The receipt hash equals the sha256 of the exact request body sent (test: `the receipt hash matches the exact bytes sent`).
- Redacted values never appear in the outbound body (same test). A name is hidden everywhere in one disclosure under one placeholder, so the question and the passages agree (test: `hides a name everywhere in one disclosure, under one placeholder, even when written short`).
- A name the vault points at once, or holds as a contact, is hidden in a passage where nothing points at it, in English and Arabic, on the desktop and in the browser build (tests: `test/people.test.ts`).
- Editing or deleting any ledger entry breaks verification at that entry (tests: `the ledger`).
- Verification needs only `receipts.jsonl` and `ledger.jsonl`. No vault, no account, no network.
- Retrieval understands meaning, on device: "who is my doctor?" finds the note that says GP, which BM25 alone misses (test: `hybrid finds the GP for "doctor", and sends nothing from other notes`).
- The embedding model is checked against a pinned SHA-256 before it runs, and refused if it does not match (test: `refuses a model file that does not match its pinned hash`).
- Saving a memory sends nothing and writes no receipt (test: `saving a memory sends nothing, writes no ledger entry, and seals it`).
- Through the company gateway, redacted values never appear in the body forwarded to the provider, and the receipt hash equals the sha256 of that body (tests: `test/gateway.test.ts`).
- An MCP client receives the answer only, with private values still placeholders, and the handover is signed into the same chain as the model call (tests: `test/mcp.test.ts`).
- When the model asks to remember something, it only ever saw placeholders. The real values are put back and sealed on device (test: `keeps what the model asks to remember, with the real values put back on device`).

- The agent vault: the API receives the real value, while the agent, the receipts, the ledger and the vault file never hold it in any common encoding. Requests to a host that was not allowed, over plain http, in a part of the request that was not allowed, or naming the host by placeholder are refused and send nothing, yet are still receipted. Echoes are blanked, editing or deleting a receipt breaks the chain, and a chain re-signed under another key names that key (tests: `test/vault.test.ts`).

The privacy claims each have their own test, including three that prove what NOAI does **not** hide: `node --test test/claims.test.ts`.

Not proven, stated plainly:

- A receipt is a signed statement by your device. It proves what your device sent and that the record was not altered afterwards. It cannot prove what the provider does with a request once it arrives.
- Semantic retrieval is looser than keyword retrieval. Asked "who is my doctor?", the demo sends the GP line, the dentist memory and the allergy line from the same health note. Nothing from money, family or travel goes out, but the allergy line is a near miss the tape shows plainly.
- Through a voice assistant, the assistant's provider already hears the spoken question and receives the answer it is handed. NOAI limits and records that handover; it cannot limit what the assistant does with it. Any kind allowed in `NOAI_MCP_REVEAL` is handed over in the clear.
- The redactor runs on the device with no model. It catches structured identifiers (emails, phone numbers, Saudi national ID and Iqama numbers, passport numbers, IBANs, card numbers, API keys, IP addresses, in Latin or Arabic digits) and names of people in English or Arabic when they are on its list of given names, follow a title or relation ("Dr.", "my brother", "السيد", "أخي"), are named that way anywhere in the vault, or are in the owner's imported contacts. An unusual name that nothing in the vault points at and no contact holds is sent as written (see [Names](#names)). Dates and free text are sent. The passages it sends are the minimum needed, and the tape shows every word of them.

## Run it

Requires Node 22.18 or later. One runtime dependency, onnxruntime-web, which runs the embedding model as WebAssembly with no native code. Without the model NOAI falls back to BM25 alone and says so.

```bash
git clone https://github.com/SilentKeyTech/noai && cd noai
npm install                     # onnxruntime-web, plus typescript for dev
npm run model                   # one time: fetch the 23 MB embedding model, hash checked
echo NEBIUS_API_KEY=your_key > .env
npm test                        # 115 tests, no network
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

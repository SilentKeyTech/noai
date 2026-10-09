# README truth check

Every claim in README.md and FEEDBACK.md that names a test, a count, a file, a port, a command, a flag, a number or a behaviour was checked against the code in this repository, line by line, on 9 Oct 2026 at commit `39fd9b319f1d3b84bfad693da2b2d63b4a1231c9` (origin/main). Checked with grep, by reading the source, by running `npm test` (240 tests, 238 pass, 2 skipped because the embedding model is not fetched here), `node --test test/claims.test.ts`, small scripts that call `redact()` directly, `git log`, `wc -l` and `node --version` (v22.22.0). Nothing was fetched from the network. A claim that needs the network, the live demo, the embedding model, another repository, or a measurement someone took on a given day is marked unverifiable and left as it is.

Line numbers are those of README.md before the edits; the edits change no line count, so they still hold after.

## README.md

### Top and How NOAI works (lines 1 to 33)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 5 | Live demo at noai-silentkey.netlify.app | unverifiable | needs the network | |
| 7 | Runs on NVIDIA Nemotron 3 Super served by Nebius Token Factory | true | `src/prompt.ts:9` DEFAULT_MODEL `nvidia/nemotron-3-super-120b-a12b`; `src/gate.ts:52` baseUrl `https://api.tokenfactory.nebius.com/v1` | |
| 7 | Built for the Nebius x NVIDIA hackathon by Silent Key Technologies | unverifiable | external event | |
| 16 | Vault is AES-256-GCM, key from the passphrase | true | `src/crypto.ts:20` CIPHER `aes-256-gcm`; `:58` scryptSync(passphrase) | |
| 18 | Retrieval is BM25 plus MiniLM embeddings as WASM, nothing hosted | true | `src/retrieve.ts:5,111`; `src/embed.ts:3-5,53` onnxruntime-web, local files | |
| 21 | `src/gate.ts` is the only file allowed to use the network | true | `test/noai.test.ts:264` `only gate.ts touches the network`, passes | |
| 22 | Redacts names, emails, phones, IDs, IBANs, cards, keys to `[PERSON_1]` etc. | true | `src/redact.ts:101-118` kinds SECRET, EMAIL, IBAN, CARD, ID, PHONE; `:505` PERSON | |
| 23 | Refuses anything over the byte ceiling | true | `src/gate.ts:496-500` budget checked before any byte leaves | |
| 24 | sha256 of the exact bytes about to leave | true | `src/gate.ts:477` payloadHash sha256(body) | |
| 26 | Receipt Ed25519 signed, hash chained, sealed copy kept locally | true | `src/crypto.ts:107` ed25519; `src/ledger.ts:9-10` chain; `src/gate.ts:490` storeDisclosure | |
| 27 | Placeholders put back on device | true | `test/noai.test.ts:55` rehydrates locally | |
| 33 | Tape shows bytes, passages, redactions, what the model saw; Tamper button; verdict names the entry | true | `web/index.html:88` Tamper with the log; `:120-125`; `:121` brokenAt === e.seq | |

### In the browser (lines 35 to 52)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 37 | Vault in IndexedDB, AES-256-GCM through WebCrypto, scrypt and Ed25519 from the noble libraries, model as WebAssembly | true | `web/app/lib/store.js:21` indexedDB.open; `web/app/lib/wcrypto.js:12-15` noble imports; `web/app/lib/embedder.js:1-3`. "Audited" is a claim about the noble project, not checked here | |
| 37 | Same `src/` modules, transpiled not rewritten | true | `scripts/build-web.ts:4-5,19-24` PURE list | |
| 37 | Test `sends only redacted text through the relay, and the receipt verifies with the desktop verifier` | true | `test/web.test.ts:72`, passes | |
| 39 | `relay/core.mjs` is one short file | true | `wc -l`: 135 lines | |
| 41 | Relay forwards the exact bytes it received | true | `relay/core.mjs:73-82` body: bytes; `test/web.test.ts:138` | |
| 42 | Relay accepts only NOAI's system prompt, an allowlisted Nemotron model, a bounded size | true | `relay/core.mjs:52-59,74`; `test/web.test.ts:149` | |
| 43 | Relay logs nothing; a test fails the build if a logging call appears | true | `relay/core.mjs:15`; `test/web.test.ts:174` `has no logging in it at all` | |
| 45 | Receipts downloaded from the browser verify offline with `noai verify` | true | `web/app/lib/ledger.js:70-72` exportFiles writes receipts.jsonl and ledger.jsonl; `src/cli.ts:105`; `test/voice.test.ts:106` desktop verifier accepts | |
| 48 | `npm run build:web` transpiles the core, vendors the libraries, copies the model | true | `package.json` scripts; `scripts/build-web.ts:19-24,35-64,68-73` | |
| 49 | `npm run web` on http://127.0.0.1:7791 | true | `package.json` web; `relay/serve.mjs:14` port 7791 | |
| 52 | `netlify.toml` publishes `web/app`, relay as a function at `/api/chat` | true | `netlify.toml` publish = "web/app"; `netlify/functions/relay.mjs:6` path '/api/chat' | |
| 52 | CSP allows no third-party script, style or connection | false | `netlify.toml` connect-src is `'self' wss://streaming.assemblyai.com`: voice connects to AssemblyAI | Now says no third-party script or style, and that the one outside connection allowed is AssemblyAI's streaming endpoint, for voice |
| 52 | `relay/Dockerfile` runs the relay alone for Nebius Serverless | true | `relay/Dockerfile:1-11` | |
| 52 | `NOAI_ALLOWED_ORIGINS` | true | `relay/core.mjs:65,105` | |
| 52 | Per-client limit is best effort | true | `relay/core.mjs:27-33` per warm instance | |

### Skills (lines 54 to 58)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 56 | Three skills: draft a message, set a reminder, summarise a bill; a task line is added, the system prompt never changes | true | `src/skills.ts:25,32,39` ids draft, remind, bill; `:6-7,58-60`; `test/skills.test.ts:53,66` | |
| 56 | A bill summary sends the bill with its IBAN replaced and none of your notes | true | `test/skills.test.ts:80` | |
| 56 | A reminder comes back with a date, real values put back, sealed into the vault | true | `test/skills.test.ts:91` | |
| 58 | Timeout, 429 or 5xx sends the same passages once to Nemotron 3 Nano; every attempt that sent bytes is receipted | true | `src/gate.ts:57` FAST_MODEL; `:525` 429 or >= 500; `:544-556` one retry; `test/skills.test.ts:106,123` | |

### Voice (lines 60 to 66)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 62 | Press Speak, press Stop | true | `web/app/index.html:452`; `web/app/app.js:248` | |
| 62 | 16 kHz mono PCM, 50 ms frames, AssemblyAI streaming | true | `web/app/lib/voice.js:25-28` SAMPLE_RATE 16000, FRAME_SAMPLES 800; `test/voice.test.ts:77,83` | |
| 62 | Universal-3 Pro | unverifiable | `web/app/lib/voice.js:26` requests speech_model `universal-3-6-pro`; whether AssemblyAI calls that id Universal-3 Pro needs the network | |
| 62 | The formatted transcript becomes the question and goes through the gate | true | `web/app/lib/voice.js:30` format_turns=true; `:115` turn_is_formatted; `test/voice.test.ts:83` | |
| 62 | Read aloud only by an on-device voice, otherwise not read aloud | true | `web/app/app.js:226-227` localService filter; `:199` | |
| 64 | Receipt carries SHA-256 of the audio bytes, their size, the endpoint, the transcript hash | true | `web/app/lib/voice.js:158,171-177`; `test/voice.test.ts:106` | |
| 64 | Key stays on the relay at `/api/voice-token`; one-minute single-session token | true | `netlify/functions/voice-token.mjs:7`; `relay/core.mjs:93` VOICE_TOKEN_SECONDS = 60, `:112`; `test/voice.test.ts:127` | |
| 64 | Audio goes straight to AssemblyAI, never through the relay | true | `web/app/lib/voice.js:30` wss://streaming.assemblyai.com; `test/web.test.ts:181` | |
| 64 | `voice.js` is the second of exactly two files that send anything; a test holds it to one destination | true | `test/web.test.ts:181`: gate.js and voice.js send; embedder.js may only GET its own model from the same origin | |
| 64 | `ASSEMBLYAI_API_KEY` on the relay turns voice on | true | `relay/core.mjs:108,113` | |
| 66 | Voice files are MIT OR Apache-2.0 | true | SPDX headers in `web/app/lib/voice.js:1`, `web/app/lib/pcm-worklet.js:1`, `netlify/functions/voice-token.mjs:1` | |

### Import (lines 68 to 79)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 70 | WhatsApp export, Android or iPhone, English or Arabic, one note per day | true | `src/ingest.ts:9-10,48-49`; `test/ingest.test.ts:55,68,74` | |
| 70 | .txt and .md, one note per heading | true | `src/ingest.ts:11,124`; `test/ingest.test.ts:87` | |
| 70 | PDFs with a text layer, Arabic glyphs put back in reading order | true | `src/ingest.ts:161-166`; `test/ingest.test.ts:109` | |
| 70 | Importing sends nothing, writes no receipt; the same file twice adds nothing | true | `src/ingest.ts:341` newOnly; `test/ingest.test.ts:96,133` | |
| 70 | A scanned PDF is refused with a plain message; OCR not built | true | `src/ingest.ts:227`; `test/ingest.test.ts:114` | |
| 72 | .vcf contacts become one note per person, Android encoded Arabic names included | true | `src/ingest.ts:14,238,263`; `test/people.test.ts:55,78` | |
| 72 | Every contact name is hidden in every disclosure | true | `src/people.ts:7-8`; `test/people.test.ts:136` | |
| 75 | `npm run noai -- import` takes several files | true | `package.json` noai; `src/cli.ts:50-53` | |
| 76 | `npm run noai -- people` lists every always-hidden name | true | `src/cli.ts:72-80` | |
| 79 | "+ Import files" in the browser, same parser | true | `web/app/index.html:485`; `web/app/app.js:10,311` ingestText from lib/core/ingest.js | |
| 79 | pdf.js vendored, same origin, given bytes never a URL | true | `web/app/lib/pdf.js:2,16` getDocument({ data: bytes }); `scripts/build-web.ts:61-64` | |
| 79 | The browser file picker does not offer .vcf; contacts import is CLI only | false | `web/app/index.html:488` accept lists .vcf and text/vcard; `web/app/app.js:311` sends every file to ingestText, which parses vCard (`src/ingest.ts:335`) | Sentence removed |

### Names (lines 81 to 110)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 83 | Names become `[PERSON_1]`, `[PERSON_2]` and are put back on device | true | `src/redact.ts:505`; `test/noai.test.ts:84` | |
| 83 | Fixed list of English and Arabic given names, cue words, name chains, and the vault | true | `src/names.ts:100,130` GIVEN_LATIN, GIVEN_ARABIC; `:144-153` cues (dr, brother, السيد, اخي); `:159-163` abu, عبد, bin, al | |
| 85 | Whole vault read before every disclosure: names from notes, WhatsApp senders, contacts | true | `src/people.ts:7-8,114`; `test/people.test.ts:112,123` | |
| 85 | The list is rebuilt per question and never stored or sent | true | `src/people.ts:114` knownPeople computed from the notes each call; nothing writes it | |
| 87 | About forty common Arabic names have their spellings joined | true | `src/names.ts:33-76` SPELLINGS: 43 groups | |
| 87 | Mohd, Mhmd, Mohmd, Mhd, Mohammed, Muhammad and محمد are one name | true | `src/names.ts:34`; `test/people.test.ts:185,193` | |
| 90-92 | Teaching a nickname in English or Arabic hides both as one person | true | `test/people.test.ts:199,211` | |
| 95 | A nickname on a contact works the same; `noai people` lists it | true | `test/people.test.ts:222`; `src/cli.ts:77-79` | |
| 97 | King Fahd Road stays; a contact called Will hides the full name, not the word "will" | true | `src/names.ts:185-190`; `test/people.test.ts:233,238`; `redact('Will Smith said he will call', {people:['Will Smith']})` gives `[PERSON_1] said he will call` | |
| 101 | Test `LIMIT: a name the vault never points at and no contact holds still leaves the device` | true | `test/people.test.ts:244` | |
| 102 | A contact called Grace hides "grace" in "the grace period"; "my boss Approved" is taken as a name | true | `redact('The grace period ends', {people:['Grace']})` gives `The [PERSON_1] period ends`; `redact('my boss Approved the leave')` gives `my boss [PERSON_1] the leave` | |
| 103 | A typo ("Mohamemd") is not recognised | true | `redact('Mohamemd paid the deposit.')` returns it unchanged | |
| 104 | Mohd and Mohammed with no family name share one placeholder | true | `test/people.test.ts:193` | |
| 105 | Tests in `test/kinds.test.ts` | true | file exists, 12 tests pass | |
| 106 | Addresses: National Address code, numbered street, cued phrases, Arabic cues; landmarks stay | true | `src/redact.ts:78-81`; `test/kinds.test.ts:18-32` | |
| 107 | Dates of birth after born, date of birth, DOB, تاريخ الميلاد; a birthday without a year stays | true | `src/redact.ts:76`; `test/kinds.test.ts:40-50` | |
| 108 | About 35 English and 15 Arabic medical terms | true | `src/redact.ts:83-89`: 33 English entries (35 word forms counting the plural patterns), 15 Arabic | |
| 108 | It cannot judge context | true | `src/redact.ts:90` is a word-boundary regex, no context | |
| 109 | Everything else that describes a person, places, amounts and ordinary dates are sent | true | `test/claims.test.ts:146` L1 | |
| 110 | OCR not done | true | `src/ingest.ts:227` | |

### Memory (lines 112 to 116)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 114 | "remember that" keeps the fact in the vault, never calls the model, writes no receipt | true | `src/memory.ts:6-9`; `test/memory.test.ts:56` | |
| 116 | The model ends with a `REMEMBER:` line having seen only placeholders; real values swapped back; forgetting deletes the sealed entry | true | `src/prompt.ts:17`; `test/memory.test.ts:71,94`; `src/vault.ts:130-131` | |

### Voice assistants and agents, MCP (lines 118 to 136)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 120 | MCP 2025-11-25, Streamable HTTP | true | `src/mcp.ts:16,32` PROTOCOL_VERSIONS; `src/mcp-serve.ts` serves JSON-RPC over HTTP POST | |
| 120 | Alexa+ can ask it things | unverifiable | external product | |
| 122 | The assistant gets the answer only; `[P1]` citations removed | true | `src/mcp.ts:262`; `test/mcp.test.ts:109` | |
| 123 | Values stay placeholders unless `NOAI_MCP_REVEAL=PHONE` | true | `src/mcp-serve.ts:231`; `src/mcp.ts:181`; `test/mcp.test.ts:141` | |
| 124 | Result hashed, signed with the device key, chained, naming the client; two receipts per question | true | `src/mcp.ts:188-206` model `mcp:<client>`; `test/mcp.test.ts:124` | |
| 126 | Four tools: ask_noai, remember, list_reminders, verify_disclosures | true | `src/mcp.ts:149` NOTE_TOOLS; `src/mcp-serve.ts:235` default toolset notes; `test/mcp.test.ts:85` | |
| 129-133 | `NOAI_PASSPHRASE`, `NOAI_MCP_TOKEN`, `npm run mcp`, http://127.0.0.1:7792/mcp | true | `package.json` mcp; `src/mcp-serve.ts:225,233-234,237` | |
| 136 | 127.0.0.1 by default, bearer token on every request, Origin refused unless in `NOAI_MCP_ALLOWED_ORIGINS`, `NOAI_MCP_HOST`, `NOAI_MCP_PORT` | true | `src/mcp-serve.ts:84-89,232-234` | |

### Company gateway (lines 138 to 186)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 142 | `POST /v1/chat/completions`, `GET /v1/models` | true | `src/gateway-serve.ts:215,219` | |
| 142 | Open WebUI, LibreChat, Continue, scripts, the OpenAI SDKs work with it | unverifiable | external clients; `docs/open-webui.md` says not tested | |
| 145-148 | `NOAI_GATEWAY_TOKENS` as name:token pairs, `NEBIUS_API_KEY` or `NOAI_GATEWAY_KEY`, `NOAI_GATEWAY_UPSTREAM`, `npm run gateway`, http://127.0.0.1:7794/v1 | true | `src/gateway-serve.ts:5,45-52,279,287-288`; `src/gate.ts:125-126` | |
| 151 | Token of 24 characters or more | true | `src/gateway-serve.ts:52`; `test/gateway.test.ts:252` | |
| 151 | Every receipt names who, never the token | true | `src/gate.ts:210-212`; `test/staff.test.ts:101` | |
| 151 | `NOAI_GATEWAY_HOST`, `NOAI_GATEWAY_PORT`, `NOAI_GATEWAY_ALLOWED_ORIGINS`, `NOAI_GATEWAY_MODELS`, `NOAI_GATEWAY_MAX_PAYLOAD` default 200000, `NOAI_GATEWAY_TIMEOUT_MS` | true | `src/gateway-serve.ts:287-289`; `src/gate.ts:128-129` | |
| 153 | Order: hide (one placeholder space, plus vault people), refuse over the ceiling, hash, send, receipt with the redacted body sealed, put values back | true | `src/gate.ts:220-232` gatewayBody then ceiling; `:244` hash; `:268` send; `:255-257` sign and append; `src/gateway-serve.ts:177-180` sealed copy read back; `test/stream.test.ts:113` | |
| 157 | Unrecognised text is sent as written | true | `test/claims.test.ts:146` | |
| 158 | The ChatGPT and Copilot apps cannot be pointed at another address | unverifiable | external apps | |
| 159 | Images, audio, files, tool calls and function calls are refused; nothing is sent | true | `src/gate.ts:148,171-172,187`; `test/gateway.test.ts:167` | |
| 160 | Only temperature, top_p, max_tokens, stop, n, seed, penalties forwarded; `user`, `metadata` dropped | true | `src/gate.ts:146` GATEWAY_PARAMS (also max_completion_tokens); `test/gateway.test.ts:131` | |
| 161 | Real streaming; a split placeholder is held back; receipt at the end; error event on a broken stream | true | `src/gate.ts:405-438`; `test/stream.test.ts:97,139,159` | |
| 162 | Tokens do not expire; a revoked token stops on the next call; no SSO, invite or per-person limit | true | `src/staff.ts` has no expiry field; `test/staff.test.ts:90`; nothing of the kind in `src/` | |
| 166 | `/chat` streams, shows the model list, hidden kinds and receipt number; history only in the tab | true | `src/gateway-serve.ts:202`; `web/gateway-chat.html:78,95-101,120-124`; `:58-60` sessionStorage and an in-memory array | |
| 168 | `docs/open-webui.md`; that route not tested here | true | file exists; its second line says "Status: not tested" | |
| 172 | Token printed once, not stored; `staff.json` beside the vault holds only hashes | true | `src/staff-cli.ts:6,21`; `src/staff.ts:4-5,23-26,31`; `test/staff.test.ts:49` | |
| 175 | `NOAI_ADMIN_PASSWORD` at least 12 characters | true | `src/staff.ts:34` MIN_PASSWORD = 12; `src/staff-cli.ts:19` | |
| 176-179 | `npm run staff -- add <name> [--admin]`, `list`, `revoke` | true | `src/staff-cli.ts:16-35` | |
| 182 | `/admin`: chain verdict, calls, bytes and hidden values per person, latest 200 calls | true | `src/gateway-serve.ts:125,153-171` (slice(-200)) | |
| 182 | "Read what was sent" shows the redacted text, never real values | true | `web/gateway-admin.html:81`; `src/gateway-serve.ts:177-180`; `test/staff.test.ts:123` | |
| 182 | Nobody revokes themselves; five wrong passwords lock for five minutes; cookie HttpOnly and SameSite=Strict; Host check; server text as text; staff token cannot read | true | `src/gateway-serve.ts:186,90-91,136,144,104-120`; `test/staff.test.ts:165,173,193,212,147` | |
| 184 | `test/staff.test.ts` | true | 15 tests pass | |
| 186 | `test/gateway.test.ts`: no names, phones or IDs reach the provider; receipt hash equals sha256 of the body; bad token gets 401; refused requests send nothing; concurrent calls keep the chain | true | `test/gateway.test.ts:70,120,145,144-195,237` | |

### Agent vault (lines 188 to 209)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 192 | `{{secret:github_token}}` placeholder; `src/gate.ts` swaps it in; HTTPS only, allowed hosts only, header by default; otherwise refused and nothing sent | true | `src/secrets.ts:56-59,126`; `src/gate.ts:722,730-731`; `test/vault.test.ts:134,193-223` | |
| 193 | Echoes blanked as is, base64, URL-encoded, hex, JSON-escaped, even cut off; also in notes tools and anything sent to the model | true | `src/secrets.ts:189-192,215-216`; `src/gate.ts:794-797`; `test/vault.test.ts:235,277,260,511,572` | |
| 194 | Every use, sent or refused, gets an Ed25519 receipt on the same chain, recording secret, host, path, time, client, outcome, never the value | true | `src/gate.ts:569,632-708`; `test/vault.test.ts:134,296,492` | |
| 194 | `npm run vault -- verify` checks the chain offline and names the signing key | true | `src/vault-cli.ts:10,204`; `test/vault.test.ts:296,327` | |
| 195 | Same AES-256-GCM vault; text values and small files such as a `.jks` | true | `src/secrets.ts:10,22,29`; `test/vault.test.ts:47` | |
| 198-202 | `vault -- init`, `add <name> --host`, `serve`, `receipts`, `verify --expect`; value typed hidden; serve prints the `claude mcp add` line | true | `src/vault-cli.ts:5-12,121,137,190,204,285`; `:61` askHidden; `:296` | |
| 205 | `docs/agent-vault.md` five-minute Windows setup; Arabic copy; `run --file --env`; step 7 | true | `docs/agent-vault.md:1,111,118`; `docs/agent-vault.ar.md` exists | |
| 207 | Tests rehearse a stand-in `.jks`, a GitHub token and a Play token | true | `test/vault.test.ts:30,45-47` | |
| 207 | The plan for Silent Key's keys; no real key imported | unverifiable | intent, and nothing in the repo can show it | |
| 209 | Anchor `docs/agent-vault.md#limits-stated-plainly` | true | `docs/agent-vault.md:156` "## Limits, stated plainly" | |
| 209 | No independent security review | unverifiable | the guide records an internal check on 3 Oct 2026 only | |

### What is proven, and what is not (lines 211 to 238)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 215 | Test `vault stores nothing readable on disk` | false | the test is `stores nothing readable on disk and refuses a wrong passphrase` in suite `vault`, `test/noai.test.ts:167`; the quoted name is not grep-able | Replaced with the real name |
| 216 | A test scans every other source file for `fetch`, `https`, `net` or sockets | true | `test/noai.test.ts:264-276`: fetch, node:https, node:net, node:tls, node:dgram, XMLHttpRequest, WebSocket, http.request, undici | |
| 217 | Test `the receipt hash matches the exact bytes sent` | true | full name `sends only redacted text, and the receipt hash matches the exact bytes sent`, `test/noai.test.ts:180`; the quoted part is in it | |
| 218 | Test `hides a name everywhere in one disclosure, under one placeholder, even when written short` | true | `test/noai.test.ts:84` | |
| 219 | `test/people.test.ts`, desktop and browser | true | 17 tests pass; `:166` browser build | |
| 220 | Tests `the ledger` | true | `test/noai.test.ts:225-248` | |
| 221 | Verification needs only `receipts.jsonl` and `ledger.jsonl` | true | `src/ledger.ts:9-10,21-22`; `src/cli.ts:106`; `test/vault.test.ts:296` | |
| 222 | Test `hybrid finds the GP for "doctor", and sends nothing from other notes` | true | `test/memory.test.ts:134`; its suite is skipped without the model, so it did not run here | |
| 223 | Test `refuses a model file that does not match its pinned hash` | true | `test/memory.test.ts:121`, same skipped suite; the check is `src/embed.ts:47` | |
| 224 | Test `saving a memory sends nothing, writes no ledger entry, and seals it` | true | `test/memory.test.ts:56` | |
| 225 | `test/gateway.test.ts` | true | `test/gateway.test.ts:70` | |
| 226 | `test/mcp.test.ts` | true | `test/mcp.test.ts:109,124` | |
| 227 | Test `keeps what the model asks to remember, with the real values put back on device` | true | `test/memory.test.ts:71` | |
| 229 | `test/vault.test.ts`: API gets the value, nothing else holds it; refusals for host, http, placement, placeholder host; echoes blanked; tampering breaks; foreign key named | true | `test/vault.test.ts:134,193-223,235,307,320,327` | |
| 231 | `node --test test/claims.test.ts`, including three limits | true | ran it: 12 pass; L1, L2, L3 at `test/claims.test.ts:146,156,165` | |
| 236 | "who is my doctor?" sends the GP line, the dentist memory and the allergy line | unverifiable | needs the embedding model; `test/memory.test.ts:134` is skipped here | |
| 237 | Kinds in `NOAI_MCP_REVEAL` are handed over in the clear | true | `src/mcp.ts:181` | |
| 238 | Redactor catches emails, phones, Saudi ID and Iqama, passports, IBANs, cards, API keys, IPs, Latin or Arabic digits, and names by list, cue, vault or contacts | true | `src/redact.ts:101-118`; `test/noai.test.ts:104,115,126`; `src/people.ts` | |

### Run it (lines 240 to 263)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 242 | Requires Node 22.18 or later | true | `package.json` engines `>=22.18` | |
| 242 | One runtime dependency, onnxruntime-web | false | `package.json` dependencies: `@noble/curves`, `@noble/hashes`, `onnxruntime-web`, `pdfjs-dist`; the noble packages are vendored by `scripts/build-web.ts:38`, pdfjs by `:61` | Now says four, and what each is for |
| 242 | Without the model it falls back to BM25 and says so | true | `src/agent.ts:42,86`; `src/server.ts:130`; `web/app/app.js:194` | |
| 245 | `git clone https://github.com/SilentKeyTech/noai` | unverifiable | needs the network | |
| 246 | `npm install  # onnxruntime-web, plus typescript for dev` | false | same as line 242 | Now says the four runtime dependencies |
| 247 | `npm run model` fetches the embedding model, hash checked | true | `scripts/fetch-model.ts:28-36` | |
| 247 | 23 MB | unverifiable | the model cannot be fetched here; `src/embed.ts:5` says about 22 MB | |
| 248 | `NEBIUS_API_KEY` in `.env` | true | `src/gate.ts:53,452`; every script runs with `--env-file-if-exists=.env` | |
| 249 | `npm test  # 115 tests` | false | `npm test`: 240 tests, 238 pass, 2 skipped without the model | Now says 240 |
| 250 | `npm run serve` on http://127.0.0.1:7788 | true | `src/server.ts:16,128` | |
| 257-260 | `noai -- init`, `seed`, `ask`, `verify` | true | `src/cli.ts:27,33,84,105` | |
| 263 | Defaults: `NOAI_MODEL` nemotron-3-super-120b-a12b, `NOAI_MAX_PAYLOAD` 8000, `NOAI_MAX_TOKENS` 4096, `NOAI_HOME` ./.noai, `NOAI_PORT` 7788 | true | `src/gate.ts:54-56`; `src/home.ts:5`; `src/server.ts:16` | |

### How we used Nebius and NVIDIA (lines 265 to 271)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 267 | Model id `nvidia/nemotron-3-super-120b-a12b` | true | `src/prompt.ts:9` | |
| 267 | Benchmark of four tiers, about one second, about USD 0.0001 per answer | unverifiable | measured on the network | |
| 267 | Nemotron 3 Nano 30B is the tested fast fallback | true | `src/prompt.ts:10`; `test/skills.test.ts:105-135` | |
| 268 | OpenAI compatible endpoint, one plain `fetch`, no SDK, one file | true | `src/gate.ts:66`; no SDK in `package.json`; today four `fetch(` call sites, all in `src/gate.ts` | |
| 269 | Hosted embedding model not used | true | `src/embed.ts:3` | |
| 271 | `FEEDBACK.md` | true | file exists | |

### Built on BurnKey, License, Built before the hackathon (lines 273 to 283)

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 275, 283 | A test checks `src/crypto.ts` is identical to BurnKey's | true | `test/noai.test.ts:278`; skipped unless `C:/BurnKey/burnkey-core/src/crypto.ts` exists, so it did not run here | |
| 275, 283 | `src/crypto.ts` is byte identical to BurnKey's | unverifiable | the BurnKey repository is not here | |
| 275 | scrypt to a key encryption key, random master key, AES-256-GCM, Ed25519, canonical JSON | true | `src/crypto.ts:20,45,58,107,140` | |
| 279 | Apache 2.0, `LICENSE` | true | `LICENSE:1-2`; `package.json` license | |
| 283 | First committed to BurnKey on 1 September 2026 | unverifiable | another repository | |
| 283 | First commit of this repository on 20 September 2026 | true | `git log --reverse`: `1317ae9 2026-09-20 Initial commit` | |

## FEEDBACK.md

| Line | Claim | Verdict | Evidence | Change |
|---|---|---|---|---|
| 3 | Final, 26 Sep 2026 | true | `git log`: `7e6739d 2026-09-26 README and feedback, final for submission` | |
| 7 | Chat completions at `https://api.tokenfactory.nebius.com/v1` | true | `src/gate.ts:52` | |
| 8 | `nvidia/nemotron-3-super-120b-a12b` answers every question | true | `src/prompt.ts:9`; `src/gate.ts:54` | |
| 9 | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` is the fallback on timeout, 429 or 5xx; once; both attempts receipted | true | `src/prompt.ts:10`; `src/gate.ts:525,544-556`; `test/skills.test.ts:106` | |
| 10 | Also benchmarked Ultra 550B and 3.5 Lightning | unverifiable | measurement | |
| 14 | Key worked on the first call, 20 Sep 2026 | unverifiable | measurement | |
| 15 | `GET /v1/models` returned 24 models in 0.70 s | unverifiable | measurement | |
| 16 | No SDK; the entire network surface is one `fetch` in one file | true | no SDK in `package.json`; at `7e6739d` (the day it was written) `src/gate.ts` had one `fetch(` and no other `src/` file had any; today four call sites, still all in `src/gate.ts` | |
| 20 | 4 tiers, 3 cases, 2 budgets, 24 calls, USD 0.0041; Ultra 4.6 times the cost | unverifiable | measurement | |
| 21 | NOAI sends `[PHONE_1]` instead of a number and puts the value back on device | true | `src/prompt.ts:15`; `test/noai.test.ts:55` | |
| 21 | Super used the placeholder verbatim and never guessed | unverifiable | model behaviour | |
| 22 | NOAI asks for `[P1]` citations | true | `src/prompt.ts:16,21` | |
| 22 | It cited consistently | unverifiable | model behaviour | |
| 23 | Round trips of 1.5 to 2.9 s on 26 Sep | unverifiable | measurement | |
| 24 | 945 bytes, 233 prompt tokens, 227 completion tokens, 2.5 s | unverifiable | measurement | |
| 28 | Lightning at `max_tokens` 256 spent the budget reasoning | unverifiable | measurement | |
| 28 | NOAI now treats `finish_reason: length` as a failure | true | `src/gate.ts:538-539`; `test/noai.test.ts:210` | |
| 29 | Reasoning share: Lightning 99 to 100, Ultra 82, Super 69 to 74 percent | unverifiable | measurement | |
| 30 | Nano does not report `reasoning_tokens` | unverifiable | measurement | |
| 31 | Lightning spent 1,971 tokens and refused | unverifiable | measurement | |
| 32 | Pricing page 404 on 23 Sep; USD 0.30 and 0.90 per million | unverifiable | network, dated | |
| 33 | Qwen3.5-397B returned null content twice | unverifiable | measurement | |
| 37 | Would build with them again | unverifiable | opinion | |

## Totals

README.md: 160 claims checked. 140 true, 6 false, 14 unverifiable.

FEEDBACK.md: 23 claims checked. 8 true, 0 false, 15 unverifiable.

## Edits made

README.md only. FEEDBACK.md is unchanged.

- Line 52: the Content Security Policy sentence now says no third-party script or style, and that the one outside connection it allows is AssemblyAI's streaming endpoint, for voice. The policy in `netlify.toml` lists `wss://streaming.assemblyai.com` in connect-src.
- Line 79: removed "The browser file picker does not offer .vcf files yet; contacts import is in the command line for now." The picker accepts .vcf and the tab imports contacts with the same parser.
- Line 215: the test name is now `stores nothing readable on disk and refuses a wrong passphrase`, the name in `test/noai.test.ts`.
- Line 242: "One runtime dependency, onnxruntime-web" is now four, naming onnxruntime-web, pdfjs-dist, @noble/hashes and @noble/curves and what each does.
- Line 246: the `npm install` comment now says the four runtime dependencies.
- Line 249: the `npm test` comment now says 240 tests.

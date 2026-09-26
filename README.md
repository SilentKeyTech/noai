# NOAI

Pronounced No Eye. A personal AI that answers questions about your private life without the model ever seeing it.

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
                 1. redact    emails, phones, IBANs, cards, keys become [PHONE_1] etc.
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

## Memory

Start a message with "remember that" and NOAI keeps the fact in the sealed vault. That never calls the model, so it writes no receipt: nothing left.

The model can also keep things. If your question tells it something new ("Sami has a new number now, ..."), it ends its reply with a `REMEMBER:` line. It only ever saw `[PHONE_1]`, so the device swaps the real number back in before sealing the memory. Every memory shows in the vault list and can be forgotten, which deletes the sealed entry rather than hiding it.

## What is proven, and what is not

Proven by the code and the tests:

- The vault file contains no readable note text (test: `vault stores nothing readable on disk`).
- Only `src/gate.ts` can reach the network. A test scans every other source file and fails the build if one calls `fetch`, `https`, `net` or sockets.
- The receipt hash equals the sha256 of the exact request body sent (test: `the receipt hash matches the exact bytes sent`).
- Redacted values never appear in the outbound body (same test).
- Editing or deleting any ledger entry breaks verification at that entry (tests: `the ledger`).
- Verification needs only `receipts.jsonl` and `ledger.jsonl`. No vault, no account, no network.
- Retrieval understands meaning, on device: "who is my doctor?" finds the note that says GP, which BM25 alone misses (test: `hybrid finds the GP for "doctor", and sends nothing from other notes`).
- The embedding model is checked against a pinned SHA-256 before it runs, and refused if it does not match (test: `refuses a model file that does not match its pinned hash`).
- Saving a memory sends nothing and writes no receipt (test: `saving a memory sends nothing, writes no ledger entry, and seals it`).
- When the model asks to remember something, it only ever saw placeholders. The real values are put back and sealed on device (test: `keeps what the model asks to remember, with the real values put back on device`).

Not proven, stated plainly:

- A receipt is a signed statement by your device. It proves what your device sent and that the record was not altered afterwards. It cannot prove what the provider does with a request once it arrives.
- Semantic retrieval is looser than keyword retrieval. Asked "who is my doctor?", the demo sends the GP line, the dentist memory and the allergy line from the same health note. Nothing from money, family or travel goes out, but the allergy line is a near miss the tape shows plainly.
- The redactor is pattern based. It catches structured identifiers (emails, phone numbers, IBANs, card numbers, API keys, IP addresses), not names or free text. The passages it sends are the minimum needed, and the tape shows every word of them.

## Run it

Requires Node 22.18 or later. One runtime dependency, onnxruntime-web, which runs the embedding model as WebAssembly with no native code. Without the model NOAI falls back to BM25 alone and says so.

```bash
git clone https://github.com/SilentKeyTech/noai && cd noai
npm install                     # onnxruntime-web, plus typescript for dev
npm run model                   # one time: fetch the 23 MB embedding model, hash checked
echo NEBIUS_API_KEY=your_key > .env
npm test                        # 25 tests, no network
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

# Feedback on Nebius Token Factory and NVIDIA Nemotron

Final, 26 Sep 2026. Every figure below was measured by us on the dates given.

## What we used, and for what

- **Nebius Token Factory**, OpenAI compatible chat completions at `https://api.tokenfactory.nebius.com/v1`.
- **NVIDIA Nemotron 3 Super 120B** (`nvidia/nemotron-3-super-120b-a12b`) answers every NOAI question from redacted passages.
- **NVIDIA Nemotron 3 Nano 30B** (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) is the fallback: if Super does not answer within the timeout, or returns 429 or a 5xx, the same redacted passages go once to Nano, and both attempts are receipted.
- Also benchmarked: Nemotron 3 Ultra 550B and Nemotron 3.5 Lightning.

## Zero to hello world

- The API key worked on the first call (20 Sep 2026).
- A cold `GET /v1/models` returned 24 models in 0.70 s (25 Sep 2026).
- Because the API is OpenAI compatible, we needed no SDK. Our entire network surface is one `fetch` in one file, which matters for a privacy product: a reviewer can audit it in a minute.

## What worked well

- **Nemotron 3 Super is the right tier for a personal assistant.** Across our benchmark (4 Nemotron tiers, 3 cases, 2 token budgets, 24 calls, USD 0.0041 total) it passed every case in about 1 s, at about USD 0.0001 per answer. Ultra passed the same cases at 4.6 times the cost.
- **It respects placeholders.** We send `[PHONE_1]` instead of a real number. Super used the placeholder verbatim in its answer, so we could put the real value back on device. It never tried to guess the value.
- **It cites.** Asked to cite passages as [P1], it did so consistently, which makes the receipt tape easy to read against the answer.
- **Live, in NOAI, through the browser and the relay (26 Sep 2026):** round trips of 1.5 to 2.9 s across plain questions and all three skills.
- **Live, in NOAI:** a three-part question over 3 redacted passages, 945 bytes out, 233 prompt tokens and 227 completion tokens, answered correctly, with 2.5 s from gate to receipt (25 Sep 2026).

## What needs work

1. **Reasoning tokens eat small budgets silently.** At `max_tokens` 256, Nemotron 3.5 Lightning spent the whole budget reasoning, and the raw thinking text came back as `content`, with no answer and no error. Only `finish_reason: length` gave it away. We now treat `length` as a failure. A clear flag in the response, or a separate reasoning budget, would save every builder this bug.
2. **Reasoning overhead is large and uneven.** Share of completion tokens spent before the visible answer: Lightning 99 to 100 percent, Ultra 82, Super 69 to 74. For a short personal answer that is most of the bill. A per request switch to turn reasoning down would be valuable.
3. **Nano does not report `reasoning_tokens`**, although it returns about 70 completion tokens for a one line answer, so its overhead cannot be measured.
4. **Lightning refused a question it could answer.** At 4000 tokens it spent 1,971 tokens on simple arithmetic and then replied that the answer was not in the context. For a privacy agent, a wrong refusal is as bad as a wrong answer, so we exclude it.
5. **Pricing is hard to find.** `tokenfactory.nebius.com/pricing` returned a 404 on 23 Sep 2026. We found per token prices only in the cookbook source on GitHub and in the console after login (on 26 Sep the model catalog listed Nemotron 3 Super at USD 0.30 per million input tokens and USD 0.90 per million output). A public price table would help people budget.
6. **Qwen3.5-397B returned null content** twice on 23 Sep 2026 while reporting `finish_reason: stop`. This is not a Nemotron issue, but it is the same class of silent failure.

## Would we build with them again?

Yes. Nemotron 3 Super on Token Factory gave us correct, cited answers from minimal redacted context in about a second, for a fraction of a cent, through an endpoint simple enough to put behind a single auditable gate. The fixes we would ask for are all about making reasoning behaviour visible and controllable.

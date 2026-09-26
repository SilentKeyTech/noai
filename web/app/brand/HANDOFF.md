# NOAI interface: design handoff to Kays

From: design lead. Date: 26 Sep 2026. Branch: `design/ui` (cut from `build/core`). Do not commit to main, do not deploy.
Board (private, Ramzi can share it): https://claude.ai/artifact/UewXh7s4FzS8YPMRaDftuP

This is the build spec for the approved design. Part A is what you may build now in `web/app/index.html` (markup and `<style>`) and `web/app/brand/`. Part B lists the changes that need `app.js` or `lib/`. The brief puts those out of the designer's reach, so they are yours to judge.

## 0. What is decided and what is not

| Item | Status |
|---|---|
| Logo | **Approved.** Direction C refined, "Lidded O" (board: `Logo · C refined`). |
| Layout | **Approved.** The glass dashboard layout (board rows "Glass, dark" and "Glass, light"). The earlier paper-tape and chain boards are superseded. |
| Orange family, dark and light | **Approved.** |
| Purple family, light | **Approved.** |
| Purple family, dark | **Redone to satin (no gloss, no orange), waiting for Ramzi's OK.** |
| Which family ships | **Open, Ramzi to choose**: orange, purple, or both with a viewer switch (the switch needs script, see B6). |

Build both families as tokens (section 3) so the choice is one attribute on `<html>`, not a rebuild. Until Ramzi picks, ship orange as the default, because it is the only fully approved pair.

## 1. Hard constraints (unchanged from the brief, all enforced)

- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' 'unsafe-inline'`. No CDN, no web fonts from elsewhere, no inline `<script>`, no `on*=` attributes.
- `test/web.test.ts` fails on any `src=` or `href=` starting `http:`/`https:` in `index.html`. That includes an innocent link to GitHub or the Silent Key site, so use relative links only.
- Every id app.js uses must survive with its role: `meta lock lockhint pass unlock lockerr app q ask answer stats notes seed lockbtn nt nb add wipe verdict verify tamper restore export tape`.
- Style, do not rename, the classes app.js generates: `hidden answer err kept tag forget notes verdict ok bad card broken top chips chip red hash dim`.
- 320 to 1920 px with no horizontal scroll. Dark by default, light under `prefers-color-scheme: light`. WCAG AA text, a visible focus ring on every control, `prefers-reduced-motion` respected, a real `<label>` on every input.
- Budget for everything added: under 150 KB. This design uses the system font stack and about 3 KB of SVG, so it is far under.
- Names exactly: NOAI, NVIDIA Nemotron 3 Super, Nebius Token Factory, Silent Key Technologies.
- Copy stays inside README "What is proven, and what is not". The model sees the redacted passages; never say or imply otherwise.

## 2. Brand files to write in `web/app/brand/`

The geometry is a 32-unit grid:
- **Ring (the lens):** outer radius 14, inner radius 10.6.
- **Lid:** radius 9.2. There is a gap of 1.4 between lid and ring.
- **Lid edge:** runs from y 15 and bows down to y 20, like a closed eyelid.
- **Small cut** (16 and 32 px): the ring is heavier and the lid is fused to it, so the gap cannot blur shut.

`noai-mark.svg`
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="#0A0A0A"><path fill-rule="evenodd" d="M16 2a14 14 0 1 0 0 28a14 14 0 1 0 0-28Zm0 3.4a10.6 10.6 0 1 1 0 21.2a10.6 10.6 0 1 1 0-21.2Z"/><path d="M6.85 15A9.2 9.2 0 0 1 25.15 15Q16 25 6.85 15Z"/></svg>
```

`favicon.svg` (the small cut, which follows the tab's theme)
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>path{fill:#0A0A0A}@media (prefers-color-scheme:dark){path{fill:#FFFFFF}}</style><path fill-rule="evenodd" d="M16 1a15 15 0 1 0 0 30a15 15 0 1 0 0-30Zm0 4.5a10.5 10.5 0 1 1 0 21a10.5 10.5 0 1 1 0-21Z"/><path d="M5.5 15.5A10.5 10.5 0 0 1 26.5 15.5Q16 25.5 5.5 15.5Z"/></svg>
```

`noai-wordmark.svg` (drawn shapes, no font; stems 2.6 units, cap height 21; the O is the mark)
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 75 32" fill="#0A0A0A"><path d="M1 26.5V5.5H3.9L15.4 22.63V5.5H18V26.5H15.1L3.6 9.37V26.5Z"/><path fill-rule="evenodd" d="M33 5.25a10.75 10.75 0 1 0 0 21.5a10.75 10.75 0 1 0 0-21.5Zm0 2.6a8.15 8.15 0 1 1 0 16.3a8.15 8.15 0 1 1 0-16.3Z"/><path d="M25.9 15.2A7.15 7.15 0 0 1 40.1 15.2Q33 22.8 25.9 15.2Z"/><path fill-rule="evenodd" d="M48 26.5 55.6 5.5H58.4L66 26.5H63.2L61.28 21.2H52.72L50.8 26.5ZM57 9.37 53.66 18.6H60.34Z"/><rect x="70.5" y="5.5" width="2.6" height="21"/></svg>
```

`noai-lockup.svg`: the mark at full height, a gap of 0.42 × its height, then the wordmark at 0.78 × its height, centred vertically. That is `viewBox="0 0 104 32"`, with the wordmark group at `transform="translate(45.4 3.5) scale(.78)"`.

Inside `index.html`, inline the mark and wordmark paths with `fill="currentColor"` so they take the theme colour. Link the favicon as `<link rel="icon" href="./brand/favicon.svg" type="image/svg+xml">`, which is a relative link and passes the test.

`brand/README.md` records the palette tokens (section 3), and these rules:
- **Clear space:** the height of the lid on every side (0.3 × the mark's height).
- **Minimum size:** 16 px, small cut only. Use the full mark from 24 px up. Wordmark from 12 px cap height.
- Never recolour the lid separately from the ring, add a pupil, or put the mark in a shield (the shield belongs to Silent Key Technologies).

## 3. Tokens

Put them on `:root`, dark first. Use `@media (prefers-color-scheme: light)` for light, and `:root[data-family="purple"]` to override the family. The shipping family is chosen by a static attribute on `<html>`, so no script is needed.

Token meanings:
- `--base`: the colour layer under the glass.
- `--glass-*`: the panels.
- `--well`: dark or white insets: the input and the disclosed prompt.
- `--card`: receipt cards and vault tiles.
- `--primary`: the Ask and Unlock buttons.
- `--ghost`: secondary buttons.
- `--alarm`: the Tamper button.
- `--ph`: placeholders and the redaction chip.
- `--ok` / `--bad`: chain state.

### Orange, dark (default)
```
--base: radial-gradient(620px 520px at 8% 8%, #FFB54D 0%, #FFB54D00 70%), radial-gradient(760px 560px at 78% 0%, #FF6400 0%, #FF640000 70%), radial-gradient(620px 520px at 96% 96%, #D03400 0%, #D0340000 70%), radial-gradient(680px 540px at 24% 104%, #FF8A1F 0%, #FF8A1F00 70%), #F25C05;
--glass-bg: linear-gradient(135deg, rgba(255,255,255,.30), rgba(255,255,255,.12) 42%, rgba(255,255,255,.08));
--glass-border: rgba(255,255,255,.55);  --sheen: rgba(255,255,255,.32);
--glass-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 -1px 0 rgba(255,255,255,.08), 0 30px 70px rgba(110,24,0,.4);
--text: #0A0A0A; --text-2: rgba(10,10,10,.76); --text-3: rgba(10,10,10,.64); --label: #0A0A0A; --hair: rgba(10,10,10,.16);
--well: rgba(14,10,8,.84); --well-border: rgba(0,0,0,.6); --well-text: #FF9A4D;
--answer-bg: rgba(255,255,255,.24); --answer-border: rgba(255,255,255,.55);
--card: rgba(255,255,255,.16); --card-border: rgba(255,255,255,.45);
--primary: linear-gradient(180deg, #2C2521, #0A0A0A); --primary-text: #FF9A4D;
--ghost: rgba(255,255,255,.24); --ghost-border: rgba(10,10,10,.35); --ghost-text: #0A0A0A;
--alarm: #0A0A0A; --alarm-text: #FFB27A;
--chip-border: rgba(10,10,10,.35); --chip-text: #0A0A0A; --ph: #FF7A1A; --ph-text: #0A0A0A; --red-chip: #0A0A0A; --red-chip-text: #FF9A4D;
--ok-bg: #0A0A0A; --ok-text: #7DFFD0; --rail: #0A0A0A; --link: #0A0A0A; --prompt-text: #FFB27A;
--bad-bg: #0A0A0A; --bad-border: #FF6B6B; --bad-text: #FF8A8A;
```

### Orange, light
```
--base: radial-gradient(620px 520px at 6% 8%, #FFD2A1 0%, #FFD2A100 70%), radial-gradient(760px 560px at 76% 2%, #FFB070 0%, #FFB07000 70%), radial-gradient(560px 460px at 96% 96%, #FF9A4D 0%, #FF9A4D00 70%), radial-gradient(680px 540px at 26% 104%, #FFE0C0 0%, #FFE0C000 70%), #FFEBD8;
--glass-bg: linear-gradient(135deg, rgba(255,255,255,.72), rgba(255,255,255,.42) 45%, rgba(255,255,255,.30));
--glass-border: rgba(255,255,255,.95); --sheen: rgba(255,255,255,.55);
--glass-shadow: inset 0 1px 0 #FFFFFF, inset 0 -1px 0 rgba(255,255,255,.4), 0 26px 60px rgba(160,60,0,.16);
--text: #1A1410; --text-2: rgba(26,20,16,.74); --text-3: rgba(26,20,16,.62); --label: #1A1410; --hair: rgba(26,20,16,.12);
--well: rgba(255,255,255,.84); --well-border: rgba(26,20,16,.16); --well-text: #1A1410;
--answer-bg: rgba(255,255,255,.66); --answer-border: rgba(255,255,255,.95);
--card: rgba(255,255,255,.50); --card-border: rgba(255,255,255,.95);
--primary: #2E2E34; --primary-text: #FFB27A;
--ghost: rgba(255,255,255,.62); --ghost-border: rgba(26,20,16,.16); --ghost-text: #1A1410;
--alarm: #2E2E34; --alarm-text: #FFB27A;
--chip-border: rgba(26,20,16,.18); --chip-text: #2A221C; --ph: #2E2E34; --ph-text: #FFB27A; --red-chip: #2E2E34; --red-chip-text: #FFB27A;
--ok-bg: #2E2E34; --ok-text: #7DFFD0; --rail: #2E2E34; --link: #9A3412; --prompt-text: #1A1410;
--bad-bg: #2E2E34; --bad-border: #FF8A8A; --bad-text: #FF9E9E;
```

### Purple, light (approved)
```
--base: radial-gradient(620px 520px at 6% 8%, #C9B6FF 0%, #C9B6FF00 70%), radial-gradient(760px 560px at 76% 2%, #B79BFF 0%, #B79BFF00 70%), radial-gradient(540px 440px at 96% 96%, rgba(255,176,120,.7) 0%, rgba(255,176,120,0) 70%), radial-gradient(680px 540px at 26% 104%, #D9C8FF 0%, #D9C8FF00 70%), #EEE8FF;
glass: same as Orange light, shadow tint rgba(76,29,149,.16)
--text: #1B1033; --text-2: rgba(27,16,51,.74); --text-3: rgba(27,16,51,.62); --label: #B8400B; --hair: rgba(27,16,51,.12);
--well: rgba(255,255,255,.82); --well-border: rgba(109,63,209,.28); --well-text: #1B1033;
--answer-bg / --card: as Orange light
--primary: #6D3FD1; --primary-text: #FFFFFF;
--ghost: rgba(255,255,255,.62); --ghost-border: rgba(27,16,51,.16); --ghost-text: #1B1033;
--alarm: rgba(255,122,26,.10); --alarm-border: #C2410C; --alarm-text: #A8380A;
--chip-border: rgba(27,16,51,.18); --chip-text: #2E2347; --ph: #FF7A1A; --ph-text: #1B1033; --red-chip: #FF7A1A; --red-chip-text: #1B1033;
--ok-bg: rgba(16,185,129,.12); --ok-border: rgba(4,120,87,.35); --ok-text: #046C4E; --rail: #059669; --link: #5B21B6; --prompt-text: #1B1033;
--bad-bg: rgba(190,18,60,.08); --bad-border: rgba(190,18,60,.4); --bad-text: #9F1239;
```

### Purple, dark (satin, pending OK)
```
--base: radial-gradient(900px 620px at 8% -6%, #4A2799 0%, #4A279900 70%), radial-gradient(820px 600px at 92% 8%, #33197A 0%, #33197A00 70%), radial-gradient(900px 600px at 50% 110%, #24105A 0%, #24105A00 70%), #130A2C;
--glass-bg: rgba(255,255,255,.055); --glass-border: rgba(255,255,255,.13); --sheen: rgba(255,255,255,.04);
--glass-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 20px 50px rgba(8,0,24,.45);
--text: #FFFFFF; --text-2: rgba(255,255,255,.78); --text-3: rgba(255,255,255,.62); --label: #C9B8FF; --hair: rgba(255,255,255,.12);
--well: rgba(10,4,28,.45); --well-border: rgba(255,255,255,.14); --well-text: #FFFFFF;
--answer-bg: rgba(255,255,255,.06); --answer-border: rgba(255,255,255,.14);
--card: rgba(255,255,255,.045); --card-border: rgba(255,255,255,.12);
--primary: #7C4DDB; --primary-text: #FFFFFF;
--ghost: rgba(255,255,255,.06); --ghost-border: rgba(255,255,255,.20); --ghost-text: #FFFFFF;
--alarm: rgba(201,184,255,.10); --alarm-border: #C9B8FF; --alarm-text: #EDE7FF;
--chip-border: rgba(255,255,255,.20); --chip-text: rgba(255,255,255,.86); --ph: #C9B8FF; --ph-text: #1A0E3A; --red-chip: #C9B8FF; --red-chip-text: #1A0E3A;
--ok-bg: rgba(134,239,196,.08); --ok-border: rgba(134,239,196,.35); --ok-text: #86EFC4; --rail: #86EFC4; --link: #DDD3FF; --prompt-text: rgba(255,255,255,.92);
--bad-bg: rgba(255,107,129,.10); --bad-border: rgba(255,138,160,.55); --bad-text: #FFB3C1;
```

No orange anywhere in dark purple: Ramzi asked for purple only. Green (ok) and red (bad) stay in every family because they carry chain state, and a broken chain must never be told apart by hue alone (section 6, moment 5).

Type: `system-ui, "Segoe UI Variable Text", "Segoe UI", -apple-system, sans-serif`. Mono: `"Cascadia Mono", ui-monospace, Consolas, monospace`. Labels are mono, 11 px, weight 700, tracking .18em, uppercase. Body 15 px. Answer 19 px / 1.6. No web fonts.

### Glass recipe (one class, reused)
```css
.glass{position:relative;overflow:hidden;background:var(--glass-bg);border:1px solid var(--glass-border);box-shadow:var(--glass-shadow);
  -webkit-backdrop-filter:blur(26px) saturate(170%);backdrop-filter:blur(26px) saturate(170%);border-radius:22px}
.glass::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(118deg,var(--sheen),transparent 30%)}
.glass>*{position:relative}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){ .glass{background:<the glass colour at about double opacity>} }
body{background:var(--base) fixed; min-height:100vh}
```
Blur costs paint time. Use it on the header, the three panels and the lock card only, never on each receipt card.

## 4. Layout (1440 wide is the reference board)

```
header.glass  floating: 20px from top, 24px sides, 64px tall, radius 18
  [mark 28] [wordmark 24h, inside the h1, aria-label "NOAI"] [.sub "PRONOUNCED NO EYE", mono 10.5, text-2] ....... [#meta as a mono pill, 11.5px]
main  grid: minmax(0,1fr) 584px, gap 24, 24px margins, fills the rest of the viewport
  left column (flex column, gap 24)
    Ask panel .glass (padding 28)    label for #q "ASK YOUR VAULT" .......... banner line, 12.5px, text-2
                                    well 60px: #q (16px, no border) + #ask inside it, right, 46px tall
                                    #answer: answer box, radius 16, padding 20/22, 19px
                                    #stats: mono 11.5, text-2
    Vault panel .glass (grows)       h2 "VAULT" ................................. #seed  #lockbtn (ghost, 44px)
                                    #notes as a 2-column grid of 46px tiles, gap 8/12
                                    footer, hairline above: details "Add a note" (#nt #nb #add), details "Start over" (#wipe)
  right column
    Tape panel .glass (padding 26/28, full height, flex column, gap 16)
                                    h2 "RECEIPT TAPE" + a line "Everything that left this device" (18px, 600)
                                    #verdict: status bar, radius 14
                                    #verify  #tamper  #restore  #export in one row, 44px
                                    #tape: scrolls inside the panel, fades out at the bottom (mask-image), cards on a chain rail
                                    footer, hairline above: the redaction note and the noai verify line (copy in section 5)
```

- **Spacing:** multiples of 4, and 24 between panels. Radius 22 for panels, 16 for answer, wells and cards, 12 for buttons and tiles, 999 for chips and pills.
- **Chain rail (CSS only):** `#tape .card{position:relative;margin-left:26px}`.
  - `.card::before`: the node, 10 px, `var(--rail)`, at left -21px, top 22px, with a 4 px `var(--hair)` ring.
  - `.card:not(:last-child)::after`: the line, 2 px wide, `var(--rail)` at 50% opacity, from the node down to the next card.
- **Receipt card:**
  - `.card .top`: mono 12. `#seq` in `b` at 16 px, then the time, then the bytes, pushed right.
  - The model name repeats the header, so hide it: `.card .top span:nth-child(3){display:none}`. This is fragile; B4 gives it a class.
  - `.chips`: gap 6. `.chip`: 11 px mono, 6/10 padding, pill. `.chip.red`: filled `var(--red-chip)`.
  - `details summary`: 13 px, 600, `var(--link)`, underlined with offset 3.
  - `.hash`: mono 11, `var(--text-3)`.
- **Responsive:**
  - ≤1199 px: right column 460 px.
  - ≤860 px: one column, and the tape moves below the vault. The header becomes static and wraps, with #meta on its own line. Panel padding 20.
  - ≤560 px: vault tiles in one column, and the tape buttons wrap two per row.
  - 320 px: 12 px side margins, panel padding 16. `.hash` keeps `word-break:break-all`.
  - `#meta` and `.hash` must never force a horizontal scroll.
- **Focus:** `:focus-visible{outline:2px solid var(--text);outline-offset:3px}` on every button, input, textarea and summary. On orange dark that is a black ring, on purple dark a white ring. Check it is visible on every surface it lands on.
- **Motion:**
  - A 160 ms fade and rise when a new receipt card appears.
  - A 1.2 s progress-bar sheen on the model loader.
  - Under `prefers-reduced-motion: reduce`, both go, and so does any transition over 0 ms.

## 5. Copy (static markup you may change; all inside the proven claims)

- **Header `.sub`:** "PRONOUNCED NO EYE". The old line "It never sees your life" overstates what is proven, so remove it.
- **Banner in the Ask panel:** "Sealed with AES-256-GCM in this browser. Only what the tape shows leaves it."
- **Lock card headline (moment 1):** "NOAI answers questions about your notes. The notes stay sealed in this browser, and the model only sees the few redacted lines the receipt tape shows you."
- **Tape footer:** "Numbers, emails, IBANs and cards are replaced on this device before anything is sent. Names go as written. Downloaded receipts verify offline with `noai verify`, with no browser, vault or account."
- **Labels to add:**
  - `<label for="pass">Passphrase</label>`, visible, mono label style.
  - `<label for="q">Ask your vault</label>`.
  - `<label for="nt">Title</label>` and `<label for="nb">Note</label>`.
- **Live regions:**
  - `aria-live="polite"` on `#answer`, `#stats`, `#lockhint` and `#verdict`.
  - `role="alert"` on `#lockerr`.

## 6. The seven moments

1. **First visit.**
   - `#lock` is a centred `.glass` card, max-width 520, in the left column. It holds the headline, the passphrase label, the input well with `#unlock` inside it, and `#lockhint` below.
   - `#lockhint` is mono 12 in `var(--text-2)`. While scrypt runs, app.js writes "Deriving the key with scrypt, on this device: 42%". Keep it on one line. Use `font-variant-numeric: tabular-nums` so the number does not jitter.
   - The right column shows the tape panel in its empty state: the verdict reads "Nothing has left this device yet.", and `#tape:empty::before` draws a single hollow rail node with "Receipts land here, one per question." in `var(--text-3)`.
2. **Model download.** No element exists yet; see B1. Design it as a slim bar inside the Ask panel, above the well:
   - The text line, mono 12.
   - A 4 px progress track, `var(--hair)`, with a `var(--text)` fill.
   - When ready, it shrinks to a one-line "On-device search model ready, checked against its pinned SHA-256." and then fades out after 4 s.
   - When absent, it shows "On-device model not loaded. Using BM25 keyword search." and stays.
3. **Asking.**
   - `#ask:disabled` sits at opacity .55 with `cursor:progress`.
   - While busy, `#answer` shows app.js's "Ranking in this tab, redacting, sending through the gate..." in `var(--text-2)`.
   - The answer text is calm: no box shadow and no accent colour.
4. **Exactly what the model saw.**
   - `details[open] pre` is the well: radius 12, padding 16/18, mono 12.5 / 1.75, `var(--prompt-text)`.
   - Each placeholder is a filled token: `var(--ph)` background, `var(--ph-text)`, weight 700, padding 2/7, radius 5.
   - The tokens need B2 (a `<mark class="ph">` around each placeholder). CSS cannot style part of a text node.
5. **Tamper.**
   - `.verdict.bad`: `var(--bad-bg)`, a 1 px `var(--bad-border)`, `var(--bad-text)`, weight 700.
   - `.card.broken`: a 2 px `var(--bad-border)` border and a tinted background. Its rail node turns to `var(--bad-border)` and becomes a square, so the break reads without colour.
   - `.card.broken .top::after{content:"CHAIN BREAKS HERE"}` in mono 10.5, tracking .16em.
   - Nothing flashes or shakes. It is unmistakable because it is the only thing on the tape that changed.
   - `#restore` brings back the verified state. No special styling is needed.
6. **Memory kept.**
   - `.kept` inside `#answer` is a quiet pill: `var(--ok-bg)` tint, `var(--ok-text)`, 13 px, a `::before` check glyph "✓ " (not emoji), radius 12, padding 10/14.
   - `#stats` then reads "0 bytes sent...". Make "0 bytes sent" visually lead with B5, or leave it as plain text.
7. **Empty, locked and error states.**
   - `.notes li.dim` (an empty vault): a dashed-border tile across both columns.
   - `.answer.err`: `var(--bad-bg)`, `var(--bad-border)`, `var(--bad-text)`. It carries messages like "Not answered: The relay returned 503". Show the message as is; do not add alarm icons.
   - `#lockerr`: `var(--bad-text)` on the glass, 13 px.
   - Locked (`#app.hidden`): the tape stays visible. Receipts are readable without the vault, but the disclosed prompt is not, so "Exactly what the model saw" is absent. That is correct, and it is a good line for the video.

## 7. Behaviour changes for Kays (the designer did not make these)

- **B1. Model-load status (moment 2).**
  - Add to `index.html`, in the Ask panel: `<div id="modelload" class="modelload" role="status" aria-live="polite"><span id="modeltext"></span><progress id="modelbar" max="100"></progress></div>`.
  - `embedder.js` would need `loadEmbedder(onProgress)`, reading each `fetch` body through `res.body.getReader()` with `content-length`. This stays within the test that only lets `embedder.js` fetch its own model (GET only).
  - **Check the size before writing the copy.** The brief says 22 MB, but `models/minilm-l6-v2-int8.onnx` is 22,972,370 bytes (23.0 MB), README says 23 MB, and `vendor/ort/ort-wasm-simd-threaded.wasm` adds 11.2 MB on the first visit. Honest copy is roughly "Loading the on-device search model, about 34 MB with its runtime. It never leaves this tab."
  - Only say "once" if `netlify.toml` gives these files long-lived cache headers. Verify that first.
- **B2. Placeholder marks (moment 4, needed for the video's proof moment).** In `drawTape`, change `<pre>${esc(disclosed)}</pre>` to `<pre>${esc(disclosed).replace(/\[[A-Z]+_\d+\]/g, '<mark class="ph">$&</mark>')}</pre>`. The escape runs first, so this is safe.
- **B3. Verdict stamp.** Render `<b class="stamp">VERIFIED</b> <span>${reason}</span>` (or BROKEN) instead of one text string, so the word reads as a status stamp.
- **B4. Tidier receipt cards.**
  - Give the model span a class (`class="model"`) so CSS does not rely on `nth-child`.
  - Show hashes short, `99124dd8…c3c644`, with the full value in `title` and in full inside the open details. The board uses short hashes. With today's code the full 64-character hashes print, which is correct but crowded.
- **B5. Memory stat (optional).** Wrap "0 bytes sent." in `<b>` so it can lead.
- **B6. Family switch (only if Ramzi chooses "both").** Add a toggle in the header that sets `document.documentElement.dataset.family` and keeps it in `localStorage`, inside a try/catch. The CSS in section 3 already supports it. Otherwise ship one family as a static attribute and add no script.
- **B7. Native dialogs (optional).** `confirm()` and `alert()` for forget, wipe, tamper-with-nothing and restore-with-nothing break the look in the video. Moving them to inline glass confirmations is a bigger change, so do it only if there is time.
- **B8. Rehydrated values (optional).** In the answer, the real values put back on the device (for example the phone number) could carry a subtle underline and "restored on this device" as a title. That would make the round trip visible. It needs the rehydrate step to return which spans it replaced.

## 8. Verify before handing back

1. `npm test`: all 37 pass.
2. `npm run web`, then open http://127.0.0.1:7791 with the production CSP and the console open. It must stay empty.
3. At 375 px and 1440 px, dark and light, in the shipping family, walk moments 1 to 7 with a test vault and "Load demo notes" (fictional data only). Include forcing a 503 from the relay, tamper, and restore.
4. Test keyboard only: Tab reaches every control with a visible ring, and Enter works in `#pass` and `#q`.
5. Check no horizontal scroll from 320 px to 1920 px.
6. Check `prefers-reduced-motion`.
7. Check the added weight is under 150 KB.
8. Hand back a screenshot of each moment at both widths.

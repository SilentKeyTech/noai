/**
 * The page side: finds the chat box on a covered site, puts the send guard in
 * front of it, draws the panel, and puts real values back on screen.
 *
 * Real values are drawn inside closed shadow roots, so they show on screen
 * while the page's own scripts, which can read the page and send it back,
 * still read the placeholder.
 */
import { SendGuard, type Choices, type Composer, type Page, type Sent, type Ui, type Verdict } from './guard.ts';
import { mergePolicy, readPolicy, type Policy } from './policy.ts';
import { mergeTable, PLACEHOLDER_NOTE, pieces, protect, type Entry, type Hidden } from './protect.ts';
import { siteFor, type SiteDef } from './sites.ts';

declare global {
  interface Window {
    /** set by loader.js, which catches presses before this module has loaded */
    __noaiGuard?: { key(e: KeyboardEvent): Verdict; click(e: MouseEvent): Verdict };
  }
}

const HOST_TAG = 'noai-value';
const PANEL_TAG = 'noai-panel';
const FONT = 'NOAI Tenor Sans';

/** Tenor Sans for the panel, read as bytes so the page's font rules are not involved. */
async function loadFont(): Promise<void> {
  try {
    const bytes = await (await fetch(chrome.runtime.getURL('tenor-sans.woff2'))).arrayBuffer();
    document.fonts.add(await new FontFace(FONT, bytes).load());
  } catch {
    // the system font is fine
  }
}

const ask = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

// ---------- the chat box ----------

const isElement = (x: unknown): x is Element => x instanceof Element;
const asElement = (x: unknown): Element | null => (isElement(x) ? x : x instanceof Node ? x.parentElement : null);
/** every open shadow root under `root`, so a chat box drawn inside a web component is still found */
function shadowRoots(root: ParentNode): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) out.push(el.shadowRoot, ...shadowRoots(el.shadowRoot));
  }
  return out;
}
const first = (selectors: string[], root: ParentNode = document): HTMLElement | null => {
  for (const s of selectors) {
    const el = root.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  for (const sr of shadowRoots(root)) {
    for (const s of selectors) {
      const el = sr.querySelector<HTMLElement>(s);
      if (el) return el;
    }
  }
  return null;
};
/** the element an event really started on: inside a shadow root, e.target is only its host */
const origin = (e: Event): EventTarget | null => e.composedPath()[0] ?? e.target;

function readBox(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText;
}

const tidy = (s: string): string => s.replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Replace the box's text the way typing would, so the site's editor sees the
 * change. A textarea shows it at once; a rich editor such as Lexical draws it
 * a moment later, and the guard waits for that before it trusts the box.
 */
function selectAllIn(el: HTMLElement): void {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.select();
    return;
  }
  // selectAll goes through the editor's own command; the range is a fallback for editors that ignore it
  document.execCommand('selectAll');
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Put `text` over the selection in a rich editor. Lexical (Copilot) ignores
 * insertText sent from an extension's isolated world but takes a paste, and
 * ProseMirror and Quill take one too; a plain contenteditable that does not
 * handle paste gets insertText instead.
 */
function pasteOrType(el: HTMLElement, text: string): boolean {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  el.dispatchEvent(paste);
  if (paste.defaultPrevented) return true;
  // execCommand is deprecated but is still the way to type into a plain contenteditable or a React textarea.
  return document.execCommand('insertText', false, text);
}

/**
 * Lexical reads a new selection a moment after it is made (on selectionchange),
 * so a paste sent in the same instant lands at the old caret and adds to the
 * text instead of replacing it. Select, wait, then paste.
 */
const SELECT_WAIT_MS = 50;
/** if the box still shows exactly what it showed before, the editor missed it: select and paste again */
const RETRY_MS = [300, 600];
/** only the latest write to a box acts, so a late step never puts back text the guard has since replaced */
const writes = new WeakMap<HTMLElement, number>();

function writeBox(el: HTMLElement, text: string): boolean {
  const n = (writes.get(el) ?? 0) + 1;
  writes.set(el, n);
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
    const before = tidy(readBox(el));
    const latest = (): boolean => writes.get(el) === n && el.isConnected;
    const replace = (): void => {
      selectAllIn(el);
      setTimeout(() => {
        if (latest()) pasteOrType(el, text);
      }, SELECT_WAIT_MS);
    };
    replace();
    for (const ms of RETRY_MS) {
      setTimeout(() => {
        // retry only when nothing happened at all; a box that changed is left for the guard to judge
        if (latest() && tidy(readBox(el)) === before && before !== tidy(text)) replace();
      }, ms);
    }
    return true;
  }
  selectAllIn(el);
  document.execCommand('insertText', false, text);
  if (tidy(readBox(el)) === tidy(text)) return true;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, 'value')?.set;
  set?.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return tidy(readBox(el)) === tidy(text);
}

const SEND_WORDS = /\b(send|submit)\b|إرسال|ارسال/i;

function makePage(site: SiteDef): Page {
  const box = (): HTMLElement | null => first(site.composer);
  return {
    composer(): Composer | null {
      const el = box();
      return el ? { read: () => readBox(el), write: (t) => writeBox(el, t) } : null;
    },
    inComposer(target) {
      const el = box();
      return !!el && target instanceof Node && el.contains(target);
    },
    isEditable(target) {
      const el = asElement(target);
      return !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable));
    },
    isSendButton(target) {
      const el = asElement(target);
      return !!el?.closest(site.send.join(','));
    },
    looksLikeSend(target) {
      const b = asElement(target)?.closest('button,[role="button"]');
      if (!b) return false;
      const label = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent].join(' ');
      return SEND_WORDS.test(label) || b.getAttribute('type') === 'submit';
    },
    clickSend() {
      const b = first(site.send);
      if (!b) return false;
      b.click();
      return true;
    },
  };
}

// ---------- the panel ----------

const PANEL_CSS = `
:host { all: initial; }
.card { position: fixed; right: 20px; bottom: 96px; z-index: 2147483647; width: min(380px, calc(100vw - 32px));
  font: 14px/1.45 "NOAI Tenor Sans", "Tenor Sans", -apple-system, "Segoe UI", system-ui, sans-serif; color: #1A1410;
  background: linear-gradient(135deg, #FFF7EF 0%, #FFEBD8 100%); border: 1px solid rgba(26,20,16,.14);
  border-radius: 16px; box-shadow: 0 22px 50px rgba(160,60,0,.22); padding: 16px 16px 14px; box-sizing: border-box; }
.card.warn { background: #1F1A17; color: #FFE9D6; border-color: #FF7A1A; }
.top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.mark { width: 26px; height: 26px; border-radius: 8px; background: #F25C05; color: #fff; display: grid; place-items: center; font-size: 12px; flex: none; letter-spacing: .02em; }
.warn .mark { background: #FF7A1A; color: #1F1A17; }
h2 { font: inherit; font-size: 15px; margin: 0; flex: 1; }
.x { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; opacity: .7; }
.x:hover { opacity: 1; background: rgba(0,0,0,.08); }
p { margin: 0 0 10px; color: inherit; opacity: .82; }
ul { list-style: none; margin: 0 0 12px; padding: 0; max-height: 180px; overflow: auto; }
li { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; border-top: 1px solid rgba(26,20,16,.08); }
li:first-child { border-top: 0; }
.val { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ph { font: 12px/1.3 "Cascadia Mono", ui-monospace, Consolas, monospace; background: #2E2E34; color: #FFB27A; border-radius: 6px; padding: 2px 6px; flex: none; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button.go, button.alt { font: inherit; cursor: pointer; border-radius: 10px; padding: 8px 14px; border: 1px solid transparent; }
button.go { background: #2E2E34; color: #FFB27A; }
button.go:hover { background: #0A0A0A; }
button.alt { background: transparent; color: #1A1410; border-color: rgba(26,20,16,.25); }
button.alt:hover { background: rgba(255,255,255,.6); }
button:focus-visible, .x:focus-visible { outline: 2px solid #9A3412; outline-offset: 2px; }
.hint { font-size: 12px; opacity: .65; margin: 10px 0 0; }
`;

/**
 * Keep the panel clear of the chat box and its send button: right above the
 * box when there is room, else in the top right corner.
 */
function place(card: HTMLElement, anchor: Element | null): void {
  const r = anchor?.getBoundingClientRect();
  if (!r || r.width === 0) return;
  const room = r.top - 16;
  if (room >= 220) {
    card.style.bottom = `${String(Math.round(window.innerHeight - r.top + 12))}px`;
    card.style.right = `${String(Math.max(16, Math.round(window.innerWidth - r.right)))}px`;
    card.style.maxHeight = `${String(Math.round(room - 12))}px`;
  } else {
    card.style.bottom = 'auto';
    card.style.top = '16px';
  }
  card.style.overflow = 'auto';
}

/** the visible frame around a chat box: the box itself sits inside it, a little lower */
function frameOf(box: Element | null): Element | null {
  let el = box;
  for (let i = 0; i < 5 && el?.parentElement; i++) {
    const r = el.parentElement.getBoundingClientRect();
    if (r.height > 320 || r.width > window.innerWidth * 0.98) break;
    el = el.parentElement;
  }
  return el;
}

function makeUi(anchor: () => Element | null = () => null): Ui {
  let host: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = (): void => {
    clearTimeout(timer);
    host?.remove();
    host = null;
  };
  const open = (build: (card: HTMLElement) => void, warn = false): void => {
    close();
    host = document.createElement(PANEL_TAG);
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const card = document.createElement('div');
    card.className = warn ? 'card warn' : 'card';
    card.setAttribute('role', warn ? 'alert' : 'dialog');
    card.setAttribute('aria-label', 'NOAI+');
    build(card);
    root.append(style, card);
    document.documentElement.append(host);
    place(card, anchor());
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const top = (card: HTMLElement, title: string): void => {
    const t = el('div', undefined, 'top');
    const x = el('button', '✕', 'x');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    t.append(el('span', 'N+', 'mark'), el('h2', title), x);
    card.append(t);
  };
  const list = (hidden: Hidden[]): HTMLUListElement => {
    const ul = el('ul');
    for (const h of hidden) {
      const li = el('li');
      li.append(el('span', h.value, 'val'), el('span', h.ph, 'ph'));
      ul.append(li);
    }
    return ul;
  };
  const plural = (n: number): string => (n === 1 ? '1 detail' : `${String(n)} details`);
  return {
    review(hidden: Hidden[], choices: Choices) {
      open((card) => {
        top(card, `NOAI+ hid ${plural(hidden.length)}`);
        card.append(el('p', 'The website will get the placeholders on the right. The real values stay on this computer and come back in the answer, on your screen only.'));
        card.append(list(hidden));
        const row = el('div', undefined, 'row');
        const send = el('button', 'Send protected', 'go');
        send.addEventListener('click', () => choices.send());
        row.append(send);
        if (choices.asWritten) {
          const undo = el('button', 'Undo, send as written', 'alt');
          undo.addEventListener('click', () => choices.asWritten?.());
          row.append(undo);
        }
        card.append(row, el('p', 'Or press Enter in the chat box to send protected.', 'hint'));
      });
    },
    notice(hidden: Hidden[]) {
      open((card) => {
        top(card, `NOAI+ hid ${plural(hidden.length)}`);
        card.append(list(hidden));
      });
      timer = setTimeout(close, 6000);
    },
    warn(message: string) {
      open((card) => {
        top(card, 'Not sent');
        card.append(el('p', message));
      }, true);
    },
    close,
  };
}

// ---------- real values back on screen ----------

interface Drawn {
  node: Text;
  /** what this node was cut down to; anything else means the site rewrote it */
  left: string;
  added: Node[];
}

function makeRestorer(site: SiteDef, table: () => ReadonlyMap<string, string>, skip: () => Element | null) {
  const drawn = new Map<Text, Drawn>();

  const undraw = (d: Drawn): void => {
    for (const n of d.added) n.parentNode?.removeChild(n);
    drawn.delete(d.node);
  };

  const valueNode = (ph: string, value: string): HTMLElement => {
    const host = document.createElement(HOST_TAG);
    host.setAttribute('data-noai', '');
    // The page's scripts read the placeholder here; with no slot in the shadow root it is never drawn.
    host.textContent = ph;
    const root = host.attachShadow({ mode: 'closed' });
    // A soft orange mark with a lock, so nobody reads a value put back on screen as a value that was sent.
    const style = document.createElement('style');
    style.textContent = `
      .v { background: rgba(242, 92, 5, .18); box-shadow: inset 0 0 0 1px rgba(242, 92, 5, .45); border-radius: 5px;
        padding: 0 4px 0 3px; white-space: nowrap; cursor: help; }
      svg { width: .78em; height: .78em; margin-right: 3px; vertical-align: -.04em; stroke: #F25C05; fill: none;
        stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }`;
    const span = document.createElement('span');
    span.className = 'v';
    span.title = `Shown by NOAI+ on this computer only. The website received ${ph}, not this.`;
    const svgNs = 'http://www.w3.org/2000/svg';
    const lock = document.createElementNS(svgNs, 'svg');
    lock.setAttribute('viewBox', '0 0 24 24');
    lock.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of [
      ['rect', { x: '4', y: '10.5', width: '16', height: '11', rx: '2.5' }],
      ['path', { d: 'M8 10.5V7a4 4 0 0 1 8 0v3.5' }],
    ] as const) {
      const shape = document.createElementNS(svgNs, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
      lock.append(shape);
    }
    span.append(lock, document.createTextNode(value));
    root.append(style, span);
    return host;
  };

  const draw = (node: Text): void => {
    const cut = pieces(node.data, table());
    if (!cut) return;
    const head = typeof cut[0] === 'string' ? cut.shift() as string : '';
    const added: Node[] = cut.map((p) => (typeof p === 'string' ? document.createTextNode(p) : valueNode(p.ph, p.value)));
    node.after(...added);
    node.data = head;
    drawn.set(node, { node, left: head, added });
  };

  const scan = (): void => {
    // the site rewrote or removed a node we drew on: take our part away and draw again from what is there now
    for (const d of [...drawn.values()]) {
      if (!d.node.isConnected || d.node.data !== d.left) undraw(d);
    }
    const box = skip();
    const roots = new Set<Element>();
    for (const sel of site.answers) document.querySelectorAll(sel).forEach((r) => roots.add(r));
    for (const root of roots) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n as Text;
        if (drawn.has(t) || !t.data.includes('[')) continue;
        const parent = t.parentElement;
        if (!parent || parent.closest(`${HOST_TAG},${PANEL_TAG},textarea,[contenteditable="true"]`) || (box && box.contains(t))) continue;
        draw(t);
      }
    }
  };

  let queued = false;
  const later = (): void => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      scan();
    }, 120);
  };
  new MutationObserver(later).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  later();
  return { rescan: later };
}

// ---------- start ----------

const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/**
 * The company policy. Asked of the service worker first; a worker that is
 * slow to wake or stuck must not leave the page with its presses stopped and
 * no word why, so after a short wait the policy is read here directly, from
 * the packed file and the enterprise policy.
 */
async function loadPolicy(): Promise<Policy> {
  const answer = await within(ask<Record<string, unknown>>({ type: 'policy' }), 2500);
  // read again with the defaults, so a field an older service worker does not know yet still gets its safe value
  if (answer && !('error' in answer)) return readPolicy(answer);
  const packed = await within(fetch(chrome.runtime.getURL('policy.json')).then((r) => r.json() as Promise<unknown>), 2000);
  const managed = await within(chrome.storage.managed.get(null) as Promise<unknown>, 1000);
  return mergePolicy(packed, managed);
}

async function start(): Promise<void> {
  const policy = await loadPolicy();
  const site = siteFor(location.hostname, location.pathname, policy.sites);
  if (!site) {
    // Not covered by the company's policy: step aside entirely.
    window.__noaiGuard = { key: () => 'pass', click: () => 'pass' };
    return;
  }

  void loadFont();
  let table: Entry[] = ((await chrome.storage.local.get('table')) as { table?: Entry[] }).table ?? [];
  let lookup = new Map(table.map((e) => [e.ph, e.value]));
  const restorer = policy.restoreOnScreen ? makeRestorer(site, () => lookup, () => first(site.composer)) : null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['table']) return;
    table = (changes['table'].newValue as Entry[] | undefined) ?? [];
    lookup = new Map(table.map((e) => [e.ph, e.value]));
    restorer?.rescan();
  });

  const guard = new SendGuard(
    makePage(site),
    makeUi(() => frameOf(first(site.composer))),
    (text) => {
      const p = protect(text, table, { ...policy, ...(policy.placeholderNote ? { note: PLACEHOLDER_NOTE } : {}) });
      if (p.touched.length) {
        table = mergeTable(table, p.touched, policy.keepDays);
        lookup = new Map(table.map((e) => [e.ph, e.value]));
        void chrome.storage.local.set({ table });
      }
      return p;
    },
    (sent: Sent) => {
      void ask({ type: 'receipt', facts: { origin: location.origin, site: site.id, text: sent.text, counts: sent.counts, asWritten: sent.asWritten, staffLabel: policy.staffLabel } });
    },
    policy,
  );
  window.__noaiGuard = {
    key: (e) => guard.onKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.isComposing, target: origin(e) }),
    click: (e) => guard.onClick(origin(e)),
  };
  // the toolbar icon says ON on every tab the extension is protecting, so a page it does not cover is visible
  void ask({ type: 'active' });
}

void start().catch((e: unknown) => {
  // Fail closed: if the extension could not start on a page that loaded it, presses that would send are stopped.
  console.error('NOAI+ could not start', e);
  const ui = makeUi();
  const stop = (): Verdict => {
    ui.warn('NOAI+ could not start on this page, so nothing can be sent from here. Reload the page; if it keeps happening, tell your IT team.');
    return 'stop';
  };
  const sendLike = (t: EventTarget | null): boolean => {
    const b = asElement(t)?.closest('button,[role="button"]');
    return !!b && (SEND_WORDS.test([b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent].join(' ')) || b.getAttribute('type') === 'submit');
  };
  window.__noaiGuard = {
    key: (e) => (e.key === 'Enter' && !e.shiftKey && !e.isComposing ? stop() : 'pass'),
    click: (e) => (sendLike(origin(e)) ? stop() : 'pass'),
  };
});

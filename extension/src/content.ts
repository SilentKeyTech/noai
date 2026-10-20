/**
 * The page side: finds the chat box on a covered site, puts the send guard in
 * front of it, draws the panel, and puts real values back on screen.
 *
 * Real values are drawn inside closed shadow roots, so they show on screen
 * while the page's own scripts, which can read the page and send it back,
 * still read the placeholder.
 */
import { SendGuard, type Choices, type Composer, type Page, type Sent, type Ui, type Verdict } from './guard.ts';
import type { Policy } from './policy.ts';
import { mergeTable, pieces, protect, type Entry, type Hidden } from './protect.ts';
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
const first = (selectors: string[], root: ParentNode = document): HTMLElement | null => {
  for (const s of selectors) {
    const el = root.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
};

function readBox(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText;
}

const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Replace the box's text the way typing would, so the site's editor sees the change. */
function writeBox(el: HTMLElement, text: string): boolean {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  // execCommand is deprecated but is still the one way to type into ProseMirror, Quill and React textareas alike.
  document.execCommand('insertText', false, text);
  if (tidy(readBox(el)) === tidy(text)) return true;
  if (el instanceof HTMLTextAreaElement) {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    set?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
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

function makeUi(): Ui {
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
    const span = document.createElement('span');
    span.textContent = value;
    span.title = `Shown by NOAI+ on this computer only. The website has ${ph}.`;
    span.style.cssText = 'text-decoration: underline dotted #F25C05; text-underline-offset: 3px;';
    root.append(span);
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

async function start(): Promise<void> {
  const policy = await ask<Policy>({ type: 'policy' });
  if ('error' in policy) throw new Error(String(policy.error));
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
    makeUi(),
    (text) => {
      const p = protect(text, table, policy);
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
    key: (e) => guard.onKey(e),
    click: (e) => guard.onClick(e.target),
  };
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
    click: (e) => (sendLike(e.target) ? stop() : 'pass'),
  };
});

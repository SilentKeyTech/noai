/**
 * The send hook. It sits in front of the website's own Enter key and send
 * button, and decides, synchronously, whether a press may go through.
 *
 *  - First press with something to hide: the press is stopped, the box gets
 *    the text with placeholders, and the panel lists what was hidden.
 *  - Second press (Enter, the site's button, or Send in the panel) with the
 *    box still holding exactly that text: it goes through, and a receipt is
 *    signed for what left.
 *  - Nothing to hide: the press goes through at once.
 *  - The box cannot be found on a covered site: a press that looks like
 *    sending is stopped and a warning shown. It fails closed, never open.
 *
 * Everything the page offers is behind the `Page` interface, so this file
 * holds no DOM code and is tested with plain objects.
 */
import type { Hidden, Protected } from './protect.ts';

export interface Composer {
  read(): string;
  /** put `text` in the box the way typing would; false if the box did not take it */
  write(text: string): boolean;
}

export interface Page {
  /** the chat box, or null when the site's layout no longer matches */
  composer(): Composer | null;
  /** is this event target the chat box or inside it */
  inComposer(target: unknown): boolean;
  /** is this event target somewhere a person types */
  isEditable(target: unknown): boolean;
  /** is this event target the site's send button or inside it */
  isSendButton(target: unknown): boolean;
  /** does this look like a send button, judged without the site's selectors */
  looksLikeSend(target: unknown): boolean;
  /** press the site's send button; false if it cannot be found */
  clickSend(): boolean;
}

export interface Choices {
  send(): void;
  /** absent when the company does not allow sending as written */
  asWritten?: () => void;
  cancel(): void;
}

export interface Ui {
  review(hidden: Hidden[], choices: Choices): void;
  /** after the fact, when the company sends without asking */
  notice(hidden: Hidden[]): void;
  warn(message: string): void;
  close(): void;
}

export interface Sent {
  text: string;
  hidden: Hidden[];
  counts: Record<string, number>;
  asWritten: boolean;
}

export interface GuardOptions {
  confirmBeforeSend: boolean;
  allowSendAsWritten: boolean;
}

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  target: unknown;
}

export type Verdict = 'pass' | 'stop';

export const NO_BOX =
  'NOAI+ cannot find the chat box on this page, so it cannot hide anything. Nothing was sent. The site may have changed; tell your IT team.';
export const NOT_TAKEN = 'NOAI+ could not put the protected text in the chat box. Nothing was sent.';
export const NO_BUTTON = 'NOAI+ could not find the send button. Press Enter in the chat box to send the protected text.';

const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();

export class SendGuard {
  /** the text that was cleared to go, and what it hides */
  private cleared: { text: string; sent: Sent } | null = null;
  /** set while the guard presses the send button itself */
  private pressing = false;

  private readonly page: Page;
  private readonly ui: Ui;
  private readonly protect: (text: string) => Protected;
  private readonly record: (sent: Sent) => void;
  private readonly opts: GuardOptions;

  constructor(page: Page, ui: Ui, protect: (text: string) => Protected, record: (sent: Sent) => void, opts: GuardOptions) {
    this.page = page;
    this.ui = ui;
    this.protect = protect;
    this.record = record;
    this.opts = opts;
  }

  onKey(e: KeyLike): Verdict {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return 'pass';
    if (this.page.inComposer(e.target)) return this.check();
    // A covered site whose box cannot be found: Enter in anything editable may be the message going out.
    if (this.page.isEditable(e.target) && !this.page.composer()) return this.refuse(NO_BOX);
    return 'pass';
  }

  onClick(target: unknown): Verdict {
    if (this.pressing) return 'pass';
    if (this.page.isSendButton(target)) return this.check();
    if (this.page.looksLikeSend(target) && !this.page.composer()) return this.refuse(NO_BOX);
    return 'pass';
  }

  /** A press that would send what is in the box. */
  private check(): Verdict {
    const box = this.page.composer();
    if (!box) return this.refuse(NO_BOX);
    const text = box.read();
    if (!text.trim()) return 'pass';
    if (this.cleared && tidy(this.cleared.text) === tidy(text)) return this.go(this.cleared.sent);
    this.cleared = null;
    const p = this.protect(text);
    if (p.hidden.length === 0) return this.go({ text, hidden: [], counts: {}, asWritten: false });
    if (!box.write(p.text) || tidy(box.read()) !== tidy(p.text)) {
      // The box may now hold neither text. Put back what the person wrote, and send nothing.
      box.write(text);
      return this.refuse(NOT_TAKEN);
    }
    const sent: Sent = { text: p.text, hidden: p.hidden, counts: p.counts, asWritten: false };
    this.cleared = { text: p.text, sent };
    if (!this.opts.confirmBeforeSend) {
      this.press();
      this.ui.notice(p.hidden);
      return 'stop';
    }
    this.ui.review(p.hidden, {
      send: () => this.press(),
      ...(this.opts.allowSendAsWritten ? { asWritten: () => this.sendAsWritten(text, p) } : {}),
      cancel: () => this.ui.close(),
    });
    return 'stop';
  }

  private sendAsWritten(original: string, p: Protected): void {
    const box = this.page.composer();
    if (!box) return void this.refuse(NO_BOX);
    if (!box.write(original)) return void this.refuse(NOT_TAKEN);
    this.cleared = { text: original, sent: { text: original, hidden: p.hidden, counts: p.counts, asWritten: true } };
    this.press();
  }

  /** Press the site's own send button, letting that one press through. */
  private press(): void {
    this.pressing = true;
    let ok = false;
    try {
      ok = this.page.clickSend();
    } finally {
      this.pressing = false;
    }
    if (ok) {
      if (this.cleared) this.go(this.cleared.sent);
    } else {
      this.ui.warn(NO_BUTTON);
    }
  }

  private go(sent: Sent): Verdict {
    this.cleared = null;
    this.ui.close();
    this.record(sent);
    return 'pass';
  }

  private refuse(message: string): Verdict {
    this.ui.warn(message);
    return 'stop';
  }
}

/**
 * The browser extension: what leaves the chat box, what comes back on screen,
 * and the send hook that decides whether a press may go through. No browser,
 * no DOM: the hook is driven through plain objects.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { canonical as nodeCanonical } from '../src/crypto.ts';
import { verifyDisclosure, verifyLedger } from '../src/ledger.ts';
import type { LedgerEntry, SignedDisclosure } from '../src/types.ts';
import { NO_BOX, NO_BUTTON, NOT_TAKEN, SendGuard, type Choices, type Page, type Sent, type Ui } from '../extension/src/guard.ts';
import { DEFAULT_POLICY, mergePolicy, readPolicy } from '../extension/src/policy.ts';
import { mergeTable, pieces, protect, restore, type Entry, type Hidden } from '../extension/src/protect.ts';
import { canonical, chain, newSigner, signSend } from '../extension/src/receipt.ts';
import { SITES, siteFor } from '../extension/src/sites.ts';

const NONE = { alwaysHide: [], people: [] };
const lookup = (t: readonly Entry[]) => new Map(t.map((e) => [e.ph, e.value]));

const MSG = 'Draft a reply to my brother Sami Haddad, phone 0551234567, email sami.haddad@example.com, ID 1012345678.';
const SECRETS = ['Sami', 'Haddad', '0551234567', 'sami.haddad@example.com', '1012345678'];

describe('redact before send', () => {
  it('hides names, phones, emails and IDs, and the real text comes back whole', () => {
    const p = protect(MSG, [], NONE);
    for (const s of SECRETS) assert.ok(!p.text.includes(s), `"${s}" would have been sent: ${p.text}`);
    assert.match(p.text, /\[PERSON_1\]/);
    assert.match(p.text, /\[PHONE_1\]/);
    assert.match(p.text, /\[EMAIL_1\]/);
    assert.equal(restore(p.text, lookup(p.touched)), MSG);
    assert.deepEqual(p.hidden.map((h) => h.ph), [...new Set(p.text.match(/\[[A-Z]+_\d+\]/g))]);
    assert.equal(p.counts['PERSON'], 1);
  });

  it('leaves ordinary text alone', () => {
    const p = protect('Summarise the meeting notes into three bullet points.', [], NONE);
    assert.equal(p.text, 'Summarise the meeting notes into three bullet points.');
    assert.deepEqual(p.hidden, []);
  });

  it('keeps one placeholder per value across messages, and numbers new values after the old ones', () => {
    const a = protect('Email Sami Haddad at sami@example.com', [], NONE);
    let table = mergeTable([], a.touched, 30);
    const b = protect('Ask my colleague Omar Khalil to copy sami@example.com and Sami Haddad', table, NONE);
    table = mergeTable(table, b.touched, 30);
    const sami = a.hidden.find((h) => h.kind === 'PERSON')!.ph;
    const email = a.hidden.find((h) => h.kind === 'EMAIL')!.ph;
    assert.ok(b.text.includes(sami) && b.text.includes(email), b.text);
    assert.ok(b.text.includes('[PERSON_2]'), `the new person should be PERSON_2: ${b.text}`);
    assert.equal(restore(b.text, lookup(table)), 'Ask my colleague Omar Khalil to copy sami@example.com and Sami Haddad');
  });

  it('hides a name again when it comes back alone, after a cue word found it once', () => {
    const a = protect('my brother Rakan called', [], NONE);
    assert.ok(!a.text.includes('Rakan'), a.text);
    const b = protect('Rakan agreed to the price', mergeTable([], a.touched, 30), NONE);
    assert.ok(!b.text.includes('Rakan'), `a name hidden before must stay hidden: ${b.text}`);
    assert.equal(b.text, a.text.replace(/^my brother (\[PERSON_\d+\]) called$/, '$1 agreed to the price'));
  });

  it('hides company words in any case as whole words only', () => {
    const p = protect('Falcon pricing for ACME TRADING: is falcon late? Falconry is not.', [], { alwaysHide: ['Falcon', 'Acme Trading'], people: [] });
    assert.ok(!/falcon\b/i.test(p.text.replace('Falconry', '')), p.text);
    assert.ok(p.text.includes('Falconry'), 'a longer word that starts with the term is left alone');
    assert.ok(!p.text.includes('ACME'), p.text);
    const term = p.hidden.filter((h) => h.kind === 'TERM');
    assert.equal(term.length, 2, 'Falcon and falcon are one value');
  });

  it('hides the people the company lists, in any script', () => {
    const p = protect('Prepare the brief for Lina and لينا', [], { alwaysHide: [], people: ['Lina', 'لينا'] });
    assert.ok(!p.text.includes('Lina') && !p.text.includes('لينا'), p.text);
  });

  it('never gives a value a placeholder the person typed themselves', () => {
    const p = protect('Template uses [PERSON_1]; send it to Sami Haddad', [], NONE);
    assert.ok(p.text.startsWith('Template uses [PERSON_1];'));
    assert.ok(!p.hidden.some((h) => h.ph === '[PERSON_1]'), JSON.stringify(p.hidden));
    assert.ok(!p.text.includes('Sami'));
  });

  it('forgets values older than keepDays, keeps the first value when two tabs race for one placeholder', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const old: Entry = { ph: '[PERSON_1]', value: 'Old Name', kind: 'PERSON', at: '2026-08-01T00:00:00Z' };
    const fresh: Entry = { ph: '[PHONE_1]', value: '0551234567', kind: 'PHONE', at: '2026-10-16T00:00:00Z' };
    assert.deepEqual(mergeTable([old, fresh], [], 30, now), [fresh]);
    assert.deepEqual(mergeTable([old, fresh], [], 0, now).length, 2, '0 keeps them until forgotten by hand');
    const clash: Entry = { ...fresh, value: '0559999999' };
    assert.deepEqual(mergeTable([fresh], [clash], 30, now), [fresh]);
  });
});

describe('restore on screen', () => {
  const table = new Map([['[PERSON_1]', 'Sami Haddad'], ['[PHONE_1]', '0551234567']]);

  it('cuts page text at each known placeholder', () => {
    assert.deepEqual(pieces('Dear [PERSON_1], I will call [PHONE_1].', table), [
      'Dear ',
      { ph: '[PERSON_1]', value: 'Sami Haddad' },
      ', I will call ',
      { ph: '[PHONE_1]', value: '0551234567' },
      '.',
    ]);
  });

  it('leaves text with no known placeholder untouched, including ones the model made up', () => {
    assert.equal(pieces('Nothing here', table), null);
    assert.equal(pieces('Ask [PERSON_7] instead', table), null);
    assert.equal(restore('Ask [PERSON_7] or [PERSON_1]', table), 'Ask [PERSON_7] or Sami Haddad');
  });

  it('handles a placeholder at the very start and end', () => {
    assert.deepEqual(pieces('[PERSON_1]', table), [{ ph: '[PERSON_1]', value: 'Sami Haddad' }]);
  });
});

/** A chat page made of plain objects, recording what happened to it. */
function fakePage(initial: string, opts: { box?: boolean; takes?: boolean; button?: boolean } = {}) {
  const state = { text: initial, box: opts.box ?? true, takes: opts.takes ?? true, button: opts.button ?? true, clicks: 0, sentText: [] as string[] };
  let guard: SendGuard | null = null;
  const page: Page = {
    composer: () =>
      state.box
        ? {
            read: () => state.text,
            write: (t) => {
              if (!state.takes && t !== initial) {
                state.text = '';
                return false;
              }
              state.text = t;
              return true;
            },
          }
        : null,
    inComposer: (t) => t === 'box',
    isEditable: (t) => t === 'box' || t === 'other-input',
    isSendButton: (t) => t === 'send',
    looksLikeSend: (t) => t === 'send' || t === 'mystery-send',
    clickSend: () => {
      if (!state.button) return false;
      state.clicks++;
      // the site's own click handler runs behind the guard, like a real dispatch
      if (guard?.onClick('send') === 'pass') state.sentText.push(state.text);
      return true;
    },
  };
  return { state, page, attach: (g: SendGuard) => (guard = g) };
}

function fakeUi() {
  const log = { reviews: [] as { hidden: Hidden[]; choices: Choices }[], notices: [] as Hidden[][], warnings: [] as string[], closed: 0 };
  const ui: Ui = {
    review: (hidden, choices) => log.reviews.push({ hidden, choices }),
    notice: (hidden) => log.notices.push(hidden),
    warn: (m) => log.warnings.push(m),
    close: () => log.closed++,
  };
  return { ui, log };
}

function setup(text: string, pageOpts: Parameters<typeof fakePage>[1] = {}, guardOpts = { confirmBeforeSend: true, allowSendAsWritten: true }) {
  const fp = fakePage(text, pageOpts);
  const fu = fakeUi();
  const sent: Sent[] = [];
  let table: Entry[] = [];
  const guard = new SendGuard(
    fp.page,
    fu.ui,
    (t) => {
      const p = protect(t, table, NONE);
      table = mergeTable(table, p.touched, 30);
      return p;
    },
    (s) => sent.push(s),
    guardOpts,
  );
  fp.attach(guard);
  const enter = (target: unknown = 'box', extra: Partial<{ shiftKey: boolean; isComposing: boolean }> = {}) =>
    guard.onKey({ key: 'Enter', shiftKey: false, isComposing: false, target, ...extra });
  return { ...fp, ...fu, sent, guard, enter, table: () => table };
}

describe('the send hook', () => {
  it('stops the first Enter, puts placeholders in the box and shows what was hidden', () => {
    const s = setup(MSG);
    assert.equal(s.enter(), 'stop');
    for (const v of SECRETS) assert.ok(!s.state.text.includes(v), `"${v}" still in the box: ${s.state.text}`);
    assert.equal(s.log.reviews.length, 1);
    assert.ok(s.log.reviews[0]!.hidden.some((h) => h.value === '0551234567'));
    assert.deepEqual(s.sent, [], 'nothing is sent or recorded before the second press');
  });

  it('lets the second Enter through with the protected text, and records it once', () => {
    const s = setup(MSG);
    s.enter();
    const boxed = s.state.text;
    assert.equal(s.enter(), 'pass');
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]!.text, boxed);
    assert.equal(s.sent[0]!.asWritten, false);
    assert.ok((s.sent[0]!.counts['PHONE'] ?? 0) >= 1);
  });

  it('sends from the panel by pressing the site\'s own button, once', () => {
    const s = setup(MSG);
    s.enter();
    s.log.reviews[0]!.choices.send();
    assert.equal(s.state.clicks, 1);
    assert.equal(s.state.sentText.length, 1);
    for (const v of SECRETS) assert.ok(!s.state.sentText[0]!.includes(v));
    assert.equal(s.sent.length, 1, 'one receipt for one send');
  });

  it('sends as written only when the person chooses it, and says so in the record', () => {
    const s = setup(MSG);
    s.enter();
    s.log.reviews[0]!.choices.asWritten!();
    assert.equal(s.state.sentText[0], MSG);
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]!.asWritten, true);
    assert.equal(s.sent[0]!.text, MSG);
  });

  it('offers no "send as written" when the company does not allow it', () => {
    const s = setup(MSG, {}, { confirmBeforeSend: true, allowSendAsWritten: false });
    s.enter();
    assert.equal(s.log.reviews[0]!.choices.asWritten, undefined);
  });

  it('sends at once with a notice when the company does not ask for a second press', () => {
    const s = setup(MSG, {}, { confirmBeforeSend: false, allowSendAsWritten: true });
    assert.equal(s.enter(), 'stop', 'the original press carried the real text and must not go through');
    assert.equal(s.state.sentText.length, 1);
    for (const v of SECRETS) assert.ok(!s.state.sentText[0]!.includes(v));
    assert.equal(s.log.notices.length, 1);
    assert.equal(s.sent.length, 1);
  });

  it('lets text with nothing to hide go at once, and still records it', () => {
    const s = setup('What is the capital of Norway?');
    assert.equal(s.enter(), 'pass');
    assert.equal(s.log.reviews.length, 0);
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0]!.counts, {});
  });

  it('protects again when the box was edited after protecting', () => {
    const s = setup('Call Sami Haddad');
    s.enter();
    s.state.text += ' and email omar@example.com';
    assert.equal(s.enter(), 'stop');
    assert.ok(!s.state.text.includes('omar@example.com'), s.state.text);
    assert.equal(s.sent.length, 0);
  });

  it('protects the site\'s send button the same way as Enter', () => {
    const s = setup(MSG);
    assert.equal(s.guard.onClick('send'), 'stop');
    assert.ok(!s.state.text.includes('0551234567'));
    assert.equal(s.guard.onClick('send'), 'pass');
    assert.equal(s.sent.length, 1);
  });

  it('ignores Shift+Enter, Enter while an input method is composing, and other keys', () => {
    const s = setup(MSG);
    assert.equal(s.enter('box', { shiftKey: true }), 'pass');
    assert.equal(s.enter('box', { isComposing: true }), 'pass');
    assert.equal(s.guard.onKey({ key: 'a', shiftKey: false, isComposing: false, target: 'box' }), 'pass');
    assert.equal(s.state.text, MSG);
  });

  it('leaves other inputs on the page alone while the box is there', () => {
    const s = setup(MSG);
    assert.equal(s.enter('other-input'), 'pass');
    assert.equal(s.guard.onClick('somewhere'), 'pass');
  });

  it('fails closed when the chat box cannot be found: Enter and send-like clicks are stopped with a warning', () => {
    const s = setup(MSG, { box: false });
    assert.equal(s.enter('other-input'), 'stop');
    assert.equal(s.guard.onClick('mystery-send'), 'stop');
    assert.equal(s.guard.onClick('send'), 'stop');
    assert.deepEqual([...new Set(s.log.warnings)], [NO_BOX]);
    assert.equal(s.sent.length, 0);
  });

  it('sends nothing when the box will not take the protected text, and puts back what was typed', () => {
    const s = setup(MSG, { takes: false });
    assert.equal(s.enter(), 'stop');
    assert.deepEqual(s.log.warnings, [NOT_TAKEN]);
    assert.equal(s.state.text, MSG);
    assert.equal(s.sent.length, 0);
  });

  it('says so when the send button is gone, and the next Enter still sends the protected text', () => {
    const s = setup(MSG, { button: false });
    s.enter();
    s.log.reviews[0]!.choices.send();
    assert.deepEqual(s.log.warnings, [NO_BUTTON]);
    assert.equal(s.sent.length, 0);
    assert.equal(s.enter(), 'pass');
    assert.equal(s.sent.length, 1);
    assert.ok(!s.sent[0]!.text.includes('Sami'));
  });
});

describe('receipts', () => {
  it('uses the same canonical JSON as src/crypto.ts', () => {
    const v = { b: [1, { z: 'x', a: null }], a: 'é', u: undefined, n: 1.5 };
    assert.equal(canonical(v), nodeCanonical(v));
  });

  it('signs in WebCrypto receipts that src/ledger.ts verifies, chained like the gateway\'s ledger', async () => {
    const { signer } = await newSigner();
    const receipts: SignedDisclosure[] = [];
    const ledger: LedgerEntry[] = [];
    for (const [text, asWritten] of [['Call [PERSON_1] on [PHONE_1]', false], ['plain question', false], [MSG, true]] as const) {
      const signed = await signSend({ origin: 'https://chatgpt.com', site: 'chatgpt', text, counts: { PERSON: 1 }, asWritten, staffLabel: 'staff-07' }, signer);
      receipts.push(signed);
      ledger.push(await chain(signed, ledger.at(-1)));
    }
    for (const r of receipts) assert.ok(verifyDisclosure(r), 'the gateway\'s verifier accepts it');
    assert.equal(receipts[0]!.receipt.model, 'web:chatgpt');
    assert.equal(receipts[0]!.receipt.client, 'staff-07');
    assert.match(receipts[2]!.receipt.statement, /as written/);
    assert.ok(!JSON.stringify(receipts).includes('0551234567'), 'a receipt never carries the text');
    assert.deepEqual(verifyLedger(ledger, receipts).valid, true);

    const forged = structuredClone(receipts);
    forged[1]!.receipt.payloadBytes += 1;
    assert.equal(verifyDisclosure(forged[1]!), false);
    assert.equal(verifyLedger(ledger, forged).valid, false);
    assert.equal(verifyLedger([ledger[0]!, ledger[2]!], [receipts[0]!, receipts[2]!]).valid, false, 'a removed send breaks the chain');
  });
});

describe('policy and sites', () => {
  it('falls back to the default for anything missing or of the wrong type, so a typo never turns protection off', () => {
    const p = readPolicy({ sites: 'chatgpt', confirmBeforeSend: 'no', keepDays: -3, alwaysHide: ['Falcon', 7, '  '] });
    assert.deepEqual(p.sites, DEFAULT_POLICY.sites);
    assert.equal(p.confirmBeforeSend, true);
    assert.equal(p.keepDays, 30);
    assert.deepEqual(p.alwaysHide, ['Falcon']);
    assert.deepEqual(readPolicy(null), { ...DEFAULT_POLICY });
  });

  it('lets the managed policy win over the packed file, field by field', () => {
    const p = mergePolicy({ sites: ['chatgpt', 'gemini'], alwaysHide: ['A'] }, { alwaysHide: ['B'], staffLabel: 'staff-1' });
    assert.deepEqual(p.sites, ['chatgpt', 'gemini']);
    assert.deepEqual(p.alwaysHide, ['B']);
    assert.equal(p.staffLabel, 'staff-1');
  });

  it('covers a site only when the policy names it, and the test page only under its own path', () => {
    const all = SITES.map((s) => s.id);
    assert.equal(siteFor('chatgpt.com', '/c/1', all)?.id, 'chatgpt');
    assert.equal(siteFor('copilot.microsoft.com', '/', all)?.id, 'copilot');
    assert.equal(siteFor('copilot.com', '/chats/1', all)?.id, 'copilot', 'copilot.microsoft.com now redirects here');
    assert.equal(siteFor('gemini.google.com', '/app', all)?.id, 'gemini');
    assert.equal(siteFor('chatgpt.com', '/', ['gemini']), null);
    assert.equal(siteFor('127.0.0.1', '/noai-extension-test/', all)?.id, 'local-test');
    assert.equal(siteFor('127.0.0.1', '/admin', all), null);
    for (const s of SITES) assert.ok(s.composer.length > 0 && s.send.length > 0 && s.answers.length > 0, s.id);
  });

  it('ships a manifest whose files exist, with no network permissions', () => {
    const root = new URL('../extension/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as Record<string, any>;
    assert.equal(manifest['manifest_version'], 3);
    assert.deepEqual(manifest['permissions'], ['storage']);
    assert.equal(manifest['host_permissions'], undefined);
    for (const f of ['loader.js', 'popup.html', 'policy.json', 'managed_schema.json', 'tenor-sans.woff2', ...Object.values(manifest['icons'] as Record<string, string>)]) {
      assert.ok(existsSync(new URL(f, root)), f);
    }
    // every site file's hosts are in the content script matches
    const matches: string[] = manifest['content_scripts'][0].matches;
    for (const s of SITES) for (const h of s.hosts) assert.ok(matches.some((m) => m.includes(`//${h}/`)), `${h} is not matched`);
  });
});

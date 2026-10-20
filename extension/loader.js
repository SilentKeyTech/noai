/*
 * NOAI+ content script. It listens before the page does, then loads the rest
 * as a module (content scripts cannot be modules themselves). Until the guard
 * is ready, a press that would send is stopped rather than let through.
 */
(() => {
  const SEND_WORDS = /\b(send|submit)\b|إرسال|ارسال/i;
  const el = (t) => (t instanceof Element ? t : t instanceof Node ? t.parentElement : null);
  const editable = (t) => !!el(t)?.closest('textarea,[contenteditable="true"],[contenteditable=""]');
  const sendLike = (t) => {
    const b = el(t)?.closest('button,[role="button"]');
    if (!b) return false;
    const label = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent].join(' ');
    return SEND_WORDS.test(label) || b.getAttribute('type') === 'submit';
  };
  const stop = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener(
    'keydown',
    (e) => {
      const g = window.__noaiGuard;
      const v = g ? g.key(e) : e.key === 'Enter' && !e.shiftKey && !e.isComposing && editable(e.target) ? 'stop' : 'pass';
      if (v === 'stop') stop(e);
    },
    true,
  );
  window.addEventListener(
    'click',
    (e) => {
      const g = window.__noaiGuard;
      const v = g ? g.click(e) : sendLike(e.target) ? 'stop' : 'pass';
      if (v === 'stop') stop(e);
    },
    true,
  );
  import(chrome.runtime.getURL('lib/extension/src/content.js')).catch((err) => {
    console.error('NOAI+ could not load', err);
  });
})();

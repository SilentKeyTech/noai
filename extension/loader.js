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
  // inside a shadow root e.target is only the host; the path starts where the event really did
  const origin = (e) => e.composedPath()[0] ?? e.target;
  const stop = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener(
    'keydown',
    (e) => {
      const g = window.__noaiGuard;
      const v = g ? g.key(e) : e.key === 'Enter' && !e.shiftKey && !e.isComposing && editable(origin(e)) ? 'stop' : 'pass';
      if (v === 'stop') stop(e);
    },
    true,
  );
  window.addEventListener(
    'click',
    (e) => {
      const g = window.__noaiGuard;
      const v = g ? g.click(e) : sendLike(origin(e)) ? 'stop' : 'pass';
      if (v === 'stop') stop(e);
    },
    true,
  );
  // If the rest never loads, presses that would send stay stopped, and the person is told why instead of left guessing.
  const warn = () => {
    if (document.getElementById('noai-load-warning')) return;
    const box = document.createElement('div');
    box.id = 'noai-load-warning';
    box.setAttribute('role', 'alert');
    box.textContent = 'NOAI+ could not start on this page, so nothing can be sent from here. Reload the page; if it keeps happening, tell your IT team.';
    box.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:360px;padding:14px 16px;border-radius:14px;' +
      'background:#1F1A17;color:#FFE9D6;border:1px solid #FF7A1A;font:14px/1.45 system-ui,sans-serif;box-shadow:0 18px 40px rgba(0,0,0,.35)';
    box.addEventListener('click', () => box.remove());
    document.documentElement.append(box);
  };
  const failed = () => {
    if (window.__noaiGuard) return;
    window.__noaiGuard = {
      key: (e) => (e.key === 'Enter' && !e.shiftKey && !e.isComposing && editable(origin(e)) ? (warn(), 'stop') : 'pass'),
      click: (e) => (sendLike(origin(e)) ? (warn(), 'stop') : 'pass'),
    };
  };
  import(chrome.runtime.getURL('lib/extension/src/content.js')).catch((err) => {
    console.error('NOAI+ could not load', err);
    failed();
  });
  // the module sets the guard itself within a few seconds; if it has not after 10, treat it as failed
  setTimeout(failed, 10000);
})();

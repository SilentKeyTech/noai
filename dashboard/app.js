// The NOAI window. Talks only to the NOAI app on this PC, with the token the app
// put in this window's address. It can add, list and remove keys, never read one.
(() => {
  const $ = (id) => document.getElementById(id);
  const key = (() => {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('k');
    try {
      if (fromHash) sessionStorage.setItem('noai.k', fromHash);
      return fromHash || sessionStorage.getItem('noai.k') || '';
    } catch {
      return fromHash || '';
    }
  })();
  if (location.hash) history.replaceState(null, '', location.pathname);

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'x-noai-ui': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Something went wrong.');
    return json;
  }

  const show = (el, on) => el.classList.toggle('hidden', !on);
  const say = (el, text) => {
    el.textContent = text || '';
    show(el, !!text);
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  let creating = false;

  async function boot() {
    let s;
    try {
      s = await api('GET', '/status');
    } catch (e) {
      show($('gate'), true);
      $('gate-title').textContent = 'Open NOAI from the Start menu';
      $('gate-text').textContent = 'This window has to be opened by the NOAI app on this PC.';
      show($('gate-form'), false);
      show($('gate-note'), false);
      return;
    }
    if (!s.unlocked) return gate(s.exists);
    open(s);
  }

  function gate(exists) {
    creating = !exists;
    show($('main'), false);
    show($('lock'), false);
    show($('gate'), true);
    $('pill').textContent = 'Locked';
    $('pill').classList.remove('on');
    $('gate-title').textContent = creating ? 'Welcome to NOAI' : 'Unlock NOAI';
    $('gate-text').textContent = creating
      ? 'Choose a passphrase for your vault. It seals your keys on this PC so your AI agents can use them without ever seeing them.'
      : 'Your keys stay on this PC, sealed. Type your passphrase to open them for your AI agents.';
    $('gate-go').textContent = creating ? 'Create my vault' : 'Unlock';
    show($('pass2-box'), creating);
    $('pass').autocomplete = creating ? 'new-password' : 'current-password';
    $('pass').value = '';
    $('pass2').value = '';
    say($('gate-err'), '');
    $('pass').focus();
  }

  $('gate-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const p = $('pass').value;
    if (creating && p !== $('pass2').value) return say($('gate-err'), 'The two passphrases are not the same.');
    $('gate-go').disabled = true;
    try {
      const s = await api('POST', creating ? '/create' : '/unlock', { passphrase: p });
      $('pass').value = '';
      $('pass2').value = '';
      open(s);
    } catch (e) {
      say($('gate-err'), e.message);
    } finally {
      $('gate-go').disabled = false;
    }
  };

  async function open(s) {
    show($('gate'), false);
    show($('main'), true);
    show($('lock'), true);
    $('pill').textContent = 'Unlocked · agents can connect';
    $('pill').classList.add('on');
    await Promise.all([keys(), activity(), connect()]);
  }

  async function keys() {
    const { keys: list } = await api('GET', '/secrets');
    const ul = $('keys');
    ul.replaceChildren();
    $('key-count').textContent = list.length === 1 ? '1 key' : `${list.length} keys`;
    if (!list.length) ul.append(el('li', 'empty', 'No keys yet. Add your first one below.'));
    for (const k of list) {
      const li = el('li');
      li.append(el('span', 'nm', k.name), el('span', 'tag', k.kind === 'file' ? k.fileName || 'file' : 'text'));
      const rm = el('button', 'forget', 'Remove');
      rm.type = 'button';
      rm.onclick = async () => {
        if (!confirm(`Remove ${k.name} from the vault? Agents will no longer be able to use it.`)) return;
        await api('DELETE', `/secrets/${encodeURIComponent(k.name)}`);
        keys();
      };
      li.append(rm);
      const chips = el('div', 'chips');
      chips.append(el('span', 'chip red', k.placeholder));
      for (const site of k.sites) chips.append(el('span', 'chip', site));
      chips.append(el('span', 'chip', `in ${k.where.join(', ')}`));
      li.append(chips);
      ul.append(li);
    }
  }

  for (const r of document.querySelectorAll('input[name="kind"]')) {
    r.onchange = () => {
      const file = document.querySelector('input[name="kind"]:checked').value === 'file';
      show($('k-text-box'), !file);
      show($('k-file-box'), file);
    };
  }

  $('add').onsubmit = async (ev) => {
    ev.preventDefault();
    say($('add-err'), '');
    say($('add-ok'), '');
    const file = document.querySelector('input[name="kind"]:checked').value === 'file';
    const body = {
      name: $('k-name').value,
      sites: $('k-sites').value,
      where: [...document.querySelectorAll('input[name="where"]:checked')].map((c) => c.value),
    };
    try {
      if (file) {
        const f = $('k-file').files[0];
        if (!f) throw new Error('Choose the key file.');
        if (f.size > 256 * 1024) throw new Error('That file is bigger than a key file should be (256 KB at most).');
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        body.fileBase64 = btoa(bin);
        body.fileName = f.name;
        if (body.where.length === 1 && body.where[0] === 'header') body.where = ['body'];
      } else {
        body.value = $('k-value').value;
      }
      const r = await api('POST', '/secrets', body);
      $('add').reset();
      show($('k-text-box'), true);
      show($('k-file-box'), false);
      say($('add-ok'), `Sealed. Agents use it as ${r.placeholder}`);
      keys();
    } catch (e) {
      say($('add-err'), e.message);
    } finally {
      $('k-value').value = '';
    }
  };

  async function connect() {
    try {
      const c = await api('GET', '/connect');
      $('cmd').textContent = c.command;
    } catch (e) {
      $('cmd').textContent = e.message;
    }
  }
  $('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('cmd').textContent);
      $('copied').textContent = 'Copied.';
    } catch {
      const r = document.createRange();
      r.selectNodeContents($('cmd'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      $('copied').textContent = 'Selected. Press Ctrl+C.';
    }
    setTimeout(() => ($('copied').textContent = ''), 4000);
  };

  async function activity() {
    const r = await api('GET', '/receipts');
    const v = $('verdict');
    v.className = `verdict ${r.valid ? 'ok' : 'bad'}`;
    v.textContent = r.valid
      ? r.total
        ? `All ${r.total} receipts are intact and signed by this PC.`
        : 'No key has been used yet.'
      : `Warning: ${r.reason}`;
    const tape = $('tape');
    tape.replaceChildren();
    for (const u of r.uses) {
      const link = el('div', 'link');
      const card = el('div', 'card');
      const top = el('div', 'top');
      top.append(el('b', '', u.keys.join(', ')), el('span', '', u.local ? 'given to a program on this PC' : `${u.method} ${u.host}${u.path}`));
      const ok = u.outcome === 'sent';
      top.append(el('span', `out${ok ? '' : ' no'}`, ok ? (u.local ? 'Done' : `Sent · ${u.status}`) : u.outcome === 'refused' ? 'Refused' : 'Failed'));
      card.append(top);
      const chips = el('div', 'chips');
      chips.append(el('span', 'chip', when(u.at)), el('span', 'chip', u.agent));
      if (u.echoesBlanked) chips.append(el('span', 'chip red', `${u.echoesBlanked} echo${u.echoesBlanked === 1 ? '' : 'es'} blanked`));
      card.append(chips);
      if (u.reason) card.append(el('p', 'hash', u.reason));
      link.append(el('div', 'rail'), card);
      tape.append(link);
    }
  }
  $('refresh').onclick = () => activity();

  $('lock').onclick = async () => {
    const s = await api('POST', '/lock');
    gate(s.exists);
  };

  // Keep the activity fresh while the window is open.
  setInterval(() => {
    if (!$('main').classList.contains('hidden')) activity().catch(() => undefined);
  }, 15000);

  boot();
})();

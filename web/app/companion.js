/**
 * The companion: a face that shows what NOAI is doing. Five characters, each
 * with its own voice, and each painted in the current theme's colours (the
 * theme is its skin). Purely the page's own drawing: nothing here is sent,
 * nothing here changes what the model sees, and every line it says reports
 * what the code actually did.
 *
 * States: sleep (vault locked), idle, listen (typing or speaking), think
 * (answering), happy (answered), kept (memory saved, 0 bytes sent),
 * oops (no answer), alarm (the receipt log was altered).
 */

const C = {
  noa: {
    name: 'Noa',
    about: 'Calm and precise. The NOAI eye.',
    body: '<circle class="b" cx="60" cy="60" r="52"/><circle class="s" cx="60" cy="60" r="44" stroke-width="5"/>',
    open: '<path class="i" d="M32 54A28 28 0 0 1 88 54Q60 60 32 54Z"/><ellipse class="i soft" cx="60" cy="68" rx="18" ry="4"/>',
    happy: '<path class="s" d="M34 66Q60 38 86 66" stroke-width="7"/>',
    closed: '<path class="i" d="M32 56A28 28 0 0 1 88 56Q60 80 32 56Z"/>',
    calm: '', smile: '', o: '',
    say: {
      sleep: () => 'Your vault is locked. I cannot read a thing until you open it.',
      hello: (n) => `Hello${n ? `, ${n}` : ''}. I am awake. Ask me anything about your notes.`,
      listen: () => 'Listening.',
      think: () => 'Choosing the few lines I need, and hiding the private details I can spot first.',
      happy: (k) => `Done. ${k.sent} redacted passage${k.sent === 1 ? '' : 's'} left this device, ${hidden(k.hid)}. The receipt is on the tape.`,
      kept: () => 'Kept in your vault. Nothing was sent.',
      oops: () => 'I could not get an answer this time. Nothing else changed.',
      alarm: () => 'Someone changed the receipt log. The tape shows where it breaks.',
      restored: () => 'The log is back as it was, and it checks out.',
      checkin: (k) => `Checked in: ${k.who === 'me' ? 'you' : k.who} ${k.what}. Sealed with the time, and nothing was sent.`,
      local: (k) => (k.yes ? 'I found it in your sealed check-ins, on this device. Nothing was sent.' : 'It is not in the check-ins yet. I looked on this device only, and sent nothing.'),
    },
  },
  pip: {
    name: 'Pip',
    about: 'Bouncy and curious.',
    body: '<circle class="b" cx="60" cy="62" r="50"/><circle class="i soft" cx="32" cy="76" r="7"/><circle class="i soft" cx="88" cy="76" r="7"/>',
    open: '<ellipse class="i" cx="44" cy="56" rx="6.5" ry="9.5"/><ellipse class="i" cx="76" cy="56" rx="6.5" ry="9.5"/><circle class="b" cx="46.5" cy="52" r="2.2"/><circle class="b" cx="78.5" cy="52" r="2.2"/>',
    happy: '<path class="s" d="M36 59Q44 47 52 59M68 59Q76 47 84 59" stroke-width="5"/>',
    closed: '<path class="s" d="M36 56Q44 63 52 56M68 56Q76 63 84 56" stroke-width="5"/>',
    calm: '<path class="s" d="M52 80Q60 85 68 80" stroke-width="4"/>',
    smile: '<path class="s" d="M45 76Q60 93 75 76" stroke-width="4.5"/>',
    o: '<ellipse class="i" cx="60" cy="82" rx="5" ry="6"/>',
    say: {
      sleep: () => 'Zzz... unlock me to wake me up!',
      hello: (n) => `Hi${n ? ` ${n}` : ''}! I'm Pip. What do you want to know?`,
      listen: () => 'Ooh, I am listening!',
      think: () => 'Hmm, let me look... I hide the secret bits I can spot first!',
      happy: (k) => `Found it! I only shared ${k.sent} little bit${k.sent === 1 ? '' : 's'}, ${hidden(k.hid)}.`,
      kept: () => 'I will remember that. And I did not tell anyone!',
      oops: () => 'Oh no, I could not get an answer this time.',
      alarm: () => 'Uh-oh! Someone messed with the receipts. Look at the red one!',
      restored: () => 'Phew, all fixed!',
      checkin: (k) => `Well done${k.who === 'me' ? '' : `, ${k.who}`}! I wrote it down with the time.`,
      local: (k) => (k.yes ? 'I looked in my notebook. Yes! And I did not tell anyone.' : 'I looked in my notebook, and I cannot see it yet.'),
    },
  },
  bolt: {
    name: 'Bolt',
    about: 'A tidy little robot.',
    body: '<path class="s" d="M60 26V14" stroke-width="4"/><circle class="i ant" cx="60" cy="11" r="5"/><rect class="b" x="14" y="26" width="92" height="80" rx="24"/><rect class="i faint" x="24" y="38" width="72" height="46" rx="13"/>',
    open: '<rect class="i" x="36" y="50" width="14" height="15" rx="4"/><rect class="i" x="70" y="50" width="14" height="15" rx="4"/>',
    happy: '<path class="s" d="M36 61L43 52L50 61M70 61L77 52L84 61" stroke-width="5"/>',
    closed: '<path class="s" d="M36 58H50M70 58H84" stroke-width="5"/>',
    calm: '<rect class="i" x="50" y="92" width="20" height="4" rx="2"/>',
    smile: '<path class="s" d="M48 90Q60 100 72 90" stroke-width="4"/>',
    o: '<rect class="i" x="54" y="89" width="12" height="9" rx="4"/>',
    say: {
      sleep: () => 'Standby. Unlock to power up.',
      hello: (n) => `Bolt online. Hello${n ? `, ${n}` : ''}. Ready for questions.`,
      listen: () => 'Input detected.',
      think: () => 'Scanning notes. Redacting what I recognise. Sending the minimum.',
      happy: (k) => `Task complete. ${k.sent} redacted passage${k.sent === 1 ? '' : 's'} sent, ${hidden(k.hid)}. Receipt logged.`,
      kept: () => 'Saved to vault. 0 bytes sent.',
      oops: () => 'No answer received. Nothing else changed.',
      alarm: () => 'Alert: the receipt log was altered. Check the red card.',
      restored: () => 'Log restored. Chain verified.',
      checkin: (k) => `Logged: ${k.who === 'me' ? 'you' : k.who} ${k.what}. Timestamped. 0 bytes sent.`,
      local: (k) => (k.yes ? 'Check-in found on device. 0 bytes sent.' : 'No matching check-in on device. 0 bytes sent.'),
    },
  },
  nimbus: {
    name: 'Nimbus',
    about: 'A soft, gentle cloud.',
    body: '<path class="b" d="M34 96A17 17 0 0 1 17 79A21 21 0 0 1 35 50A30 30 0 0 1 90 50A22 22 0 0 1 106 80A16 16 0 0 1 90 96Z"/>',
    open: '<circle class="i" cx="48" cy="66" r="5.5"/><circle class="i" cx="76" cy="66" r="5.5"/><circle class="b" cx="49.8" cy="64" r="1.7"/><circle class="b" cx="77.8" cy="64" r="1.7"/>',
    happy: '<path class="s" d="M41 69Q48 60 55 69M69 69Q76 60 83 69" stroke-width="4.5"/>',
    closed: '<path class="s" d="M41 66Q48 72 55 66M69 66Q76 72 83 66" stroke-width="4.5"/>',
    calm: '<path class="s" d="M56 80Q62 83 68 80" stroke-width="3.5"/>',
    smile: '<path class="s" d="M52 78Q62 89 72 78" stroke-width="4"/>',
    o: '<ellipse class="i" cx="62" cy="81" rx="4" ry="5"/>',
    say: {
      sleep: () => 'Sleeping on a soft breeze. Unlock to wake me.',
      hello: (n) => `Hello${n ? ` ${n}` : ''}, I'm Nimbus. Ask me something, slowly or quickly.`,
      listen: () => 'I am here, listening.',
      think: () => 'Drifting through your notes... hiding the private bits I can spot.',
      happy: (k) => `Here you go. Just ${k.sent} small piece${k.sent === 1 ? '' : 's'} floated out, ${hidden(k.hid)}.`,
      kept: () => 'Tucked away safe. Nothing floated out.',
      oops: () => 'A little storm. I could not get an answer.',
      alarm: () => 'Thunder! The receipts were changed. See the red one.',
      restored: () => 'Clear skies again.',
      checkin: (k) => `Lovely${k.who === 'me' ? '' : `, ${k.who}`}. Tucked away with the time.`,
      local: (k) => (k.yes ? 'I found it in the check-ins, right here on this device.' : 'I cannot find that one yet. I only looked here, on this device.'),
    },
  },
  kit: {
    name: 'Kit',
    about: 'A curious cat.',
    body: '<path class="b" d="M20 54L26 12L54 34ZM100 54L94 12L66 34Z"/><path class="i faint" d="M27 42L30 22L44 34ZM93 42L90 22L76 34Z"/><circle class="b" cx="60" cy="66" r="44"/><path class="s soft" d="M16 76H38M18 88L38 82M104 76H82M102 88L82 82" stroke-width="2.5"/><path class="i" d="M55 74H65L60 80Z"/>',
    open: '<ellipse class="i" cx="44" cy="60" rx="5.5" ry="9"/><ellipse class="i" cx="76" cy="60" rx="5.5" ry="9"/><circle class="b" cx="45.8" cy="56" r="1.8"/><circle class="b" cx="77.8" cy="56" r="1.8"/>',
    happy: '<path class="s" d="M37 62Q44 52 51 62M69 62Q76 52 83 62" stroke-width="4.5"/>',
    closed: '<path class="s" d="M37 60Q44 66 51 60M69 60Q76 66 83 60" stroke-width="4.5"/>',
    calm: '<path class="s" d="M51 84Q55.5 88 60 84Q64.5 88 69 84" stroke-width="3.5"/>',
    smile: '<path class="s" d="M48 84Q54 93 60 86Q66 93 72 84" stroke-width="3.5"/>',
    o: '<ellipse class="i" cx="60" cy="88" rx="4" ry="5"/>',
    say: {
      sleep: () => 'Curled up asleep. Unlock to wake me.',
      hello: (n) => `Meow${n ? `, ${n}` : ''}! I'm Kit. What shall we find?`,
      listen: () => 'Ears up. I am listening.',
      think: () => 'Sniffing through your notes... paws over the secrets I can spot.',
      happy: (k) => `Got it! Only ${k.sent} tiny piece${k.sent === 1 ? '' : 's'} went out, ${hidden(k.hid)}.`,
      kept: () => 'Purr. Hidden away, nothing sent.',
      oops: () => 'Hiss, no answer this time.',
      alarm: () => 'Fur up! Someone touched the receipts. See the red one.',
      restored: () => 'All tidy again. Purr.',
      checkin: (k) => `Purr-fect${k.who === 'me' ? '' : `, ${k.who}`}! Noted, with the time.`,
      local: (k) => (k.yes ? 'Found it, right here. Nothing left this device.' : 'Sniffed around. Not there yet.'),
    },
  },
};

function hidden(n) {
  if (!n) return 'and nothing needed hiding';
  return `with ${n} private detail${n === 1 ? '' : 's'} hidden first`;
}

export const CHARACTERS = Object.keys(C);

// Light falls from the top left: one gradient, defined once, shades every face.
if (typeof document !== 'undefined' && !document.getElementById('noai-face-defs')) {
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.id = 'noai-face-defs';
  defs.setAttribute('aria-hidden', 'true');
  defs.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  defs.innerHTML = '<defs><radialGradient id="noai-face-light" gradientUnits="userSpaceOnUse" cx="40" cy="30" r="96"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient></defs>';
  document.body.prepend(defs);
}

/** The face as SVG. Every state's features are drawn once; CSS shows the ones the state needs. */
export function faceSvg(id) {
  const c = C[id] ?? C.noa;
  return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><g class="body">${c.body}</g><g class="shade">${c.body}</g>`
    + `<g class="feat e-open">${c.open}</g><g class="feat e-happy">${c.happy}</g><g class="feat e-closed">${c.closed}</g>`
    + `<g class="feat m-calm">${c.calm}</g><g class="feat m-smile">${c.smile}</g><g class="feat m-o">${c.o}</g>`
    + '<g class="feat zz"><text x="96" y="34">z</text><text x="108" y="16" class="z2">Z</text></g></svg>';
}

function readChoice() {
  try {
    return localStorage.getItem('noai.character');
  } catch {
    return null;
  }
}

/**
 * Mount the companion. `face` holds the drawing, `line` its words, `picker`
 * the character buttons. Returns set(state, key, ctx) and the current name.
 */
export function mountCompanion({ face, line, picker, label }) {
  let id = C[readChoice()] ? readChoice() : 'noa';
  let state = 'sleep';
  let name = '';
  let settle = null;
  let last = ['sleep', 'sleep', {}];

  const draw = () => {
    face.innerHTML = faceSvg(id);
    face.dataset.state = state;
    face.dataset.char = id;
    if (label) label.textContent = C[id].name;
    for (const b of picker.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.char === id));
  };

  for (const cid of CHARACTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.char = cid;
    b.title = `${C[cid].name}: ${C[cid].about}`;
    b.setAttribute('aria-label', `${C[cid].name}, ${C[cid].about}`);
    b.innerHTML = `<span class="mini face" data-state="idle" data-char="${cid}">${faceSvg(cid)}</span><span class="cname">${C[cid].name}</span>`;
    b.onclick = () => {
      id = cid;
      try {
        localStorage.setItem('noai.character', cid);
      } catch {
        // private window: the choice holds for this visit
      }
      draw();
      api.set(...last);
    };
    picker.append(b);
  }

  const api = {
    /** Show a state and say the line for `key`. Happy, kept and oops settle back to idle after a while. */
    set(next, key = next, ctx = {}) {
      last = [next, key, ctx];
      clearTimeout(settle);
      state = next;
      face.dataset.state = next;
      const say = C[id].say[key];
      if (say) line.textContent = key === 'hello' ? say(name) : say(ctx);
      if (['happy', 'kept', 'oops'].includes(next)) settle = setTimeout(() => { state = 'idle'; face.dataset.state = 'idle'; }, 6000);
    },
    get state() {
      return state;
    },
    setName(n) {
      name = (n ?? '').trim().slice(0, 40);
    },
    get name() {
      return name;
    },
  };
  draw();
  return api;
}

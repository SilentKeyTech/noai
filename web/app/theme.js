/**
 * The five colourways from the NOAI Design Board, numbered so they can be
 * compared on the running product. ?theme=3 picks one; the choice is kept in
 * this browser only. No data leaves: this file only sets an attribute.
 */
const THEMES = {
  1: 'Orange glass',
  2: 'Orange glass, light',
  3: 'Purple glass, light',
  4: 'Purple satin, dark',
  5: 'Sky glass, light',
};
const root = document.documentElement;

function remembered() {
  try {
    return localStorage.getItem('noai.theme');
  } catch {
    return null;
  }
}

function apply(n) {
  const id = THEMES[n] ? String(n) : '1';
  root.dataset.theme = id;
  try {
    localStorage.setItem('noai.theme', id);
  } catch {
    // private window or blocked storage: the theme still applies for this visit
  }
  for (const b of document.querySelectorAll('#themes button')) b.setAttribute('aria-pressed', String(b.dataset.theme === id));
}

const bar = document.getElementById('themes');
for (const [n, name] of Object.entries(THEMES)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.theme = n;
  b.textContent = n;
  b.title = `${n} · ${name}`;
  b.setAttribute('aria-label', `Theme ${n}: ${name}`);
  b.onclick = () => apply(n);
  bar.append(b);
}
apply(new URLSearchParams(location.search).get('theme') ?? remembered() ?? '1');

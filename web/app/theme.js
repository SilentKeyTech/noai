/**
 * The theme switcher. Auto (no attribute) is orange and follows the device's
 * dark or light setting, in pure CSS, so the page is correct with no script.
 * Picking a theme pins it and is remembered in this browser only. It never
 * touches the vault or the ledger. ?theme=purple-dark (or a number) picks one.
 */
const THEMES = [
  ['auto', 'A', 'Auto: orange, following your device'],
  ['orange-dark', '1', 'Orange glass'],
  ['orange-light', '2', 'Orange glass, light'],
  ['purple-light', '3', 'Purple glass, light'],
  ['purple-dark', '4', 'Purple satin, dark'],
  ['sky', '5', 'Sky glass, light'],
];
const root = document.documentElement;
const byNumber = Object.fromEntries(THEMES.map(([id, n]) => [n, id]));

function read() {
  try {
    return localStorage.getItem('noai.theme');
  } catch {
    return null;
  }
}

function apply(id) {
  const known = THEMES.some(([t]) => t === id) ? id : 'auto';
  if (known === 'auto') delete root.dataset.theme;
  else root.dataset.theme = known;
  try {
    localStorage.setItem('noai.theme', known);
  } catch {
    // a private window or blocked storage: the theme still applies for this visit
  }
  for (const b of document.querySelectorAll('#themes button')) b.setAttribute('aria-pressed', String(b.dataset.theme === known));
}

const box = document.getElementById('themes');
for (const [id, n, name] of THEMES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.theme = id;
  b.title = `${n} · ${name}`;
  b.setAttribute('aria-label', `Theme ${n}: ${name}`);
  const sw = document.createElement('span');
  sw.className = `sw-${id}`;
  sw.textContent = n;
  b.append(sw);
  b.onclick = () => apply(id);
  box.append(b);
}
const asked = new URLSearchParams(location.search).get('theme');
apply(byNumber[asked] ?? asked ?? read() ?? 'auto');

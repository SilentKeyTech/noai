/** The toolbar popup: what is covered, what is kept, and the receipts export. */
import type { Policy } from './policy.ts';
import { SITES } from './sites.ts';

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const ask = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

async function show(): Promise<void> {
  const policy = await ask<Policy>({ type: 'policy' });
  $('sites').textContent = SITES.filter((s) => policy.sites.includes(s.id) && s.id !== 'local-test').map((s) => s.name.replace(/^(Microsoft|Google) /, '')).join(', ') || 'none';
  const { table = [], receipts = [] } = (await chrome.storage.local.get(['table', 'receipts'])) as { table?: unknown[]; receipts?: unknown[] };
  $('kept').textContent = String(table.length);
  $('count').textContent = policy.receipts ? String(receipts.length) : 'off';
}

$('export').addEventListener('click', async () => {
  const data = await ask<{ receipts: unknown[]; ledger: unknown[]; signer: string }>({ type: 'export' });
  const blob = new Blob([JSON.stringify({ kind: 'noai.extension-receipts', exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `noai-receipts-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

$('forget').addEventListener('click', async () => {
  await ask({ type: 'forget' });
  await show();
});

void show();

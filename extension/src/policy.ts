/**
 * The company's rules for the extension. An admin can push them two ways:
 *  - Chrome or Edge enterprise policy (chrome.storage.managed, described by
 *    managed_schema.json), which staff cannot change;
 *  - policy.json packed with the extension, for a company that sideloads it.
 * Managed policy wins field by field. Anything missing or of the wrong type
 * falls back to the default, so a typo in a policy never turns protection off.
 */
export interface Policy {
  /** which sites are covered, by id from sites.ts */
  sites: string[];
  /** words always hidden: client names, project code names, deal names */
  alwaysHide: string[];
  /** people always hidden, in any script, on top of the names NOAI finds by itself */
  people: string[];
  /** show the panel and wait for a second press before sending */
  confirmBeforeSend: boolean;
  /** offer "Undo, send as written" in the panel */
  allowSendAsWritten: boolean;
  /** swap placeholders back to the real values in the page, on screen only */
  restoreOnScreen: boolean;
  /** sign a receipt for every message sent on a covered site */
  receipts: boolean;
  /** days a placeholder and its real value are kept on this computer for restoring; 0 keeps them until forgotten by hand */
  keepDays: number;
  /** who this browser belongs to, written into each receipt, e.g. a staff id */
  staffLabel: string;
}

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  sites: ['chatgpt', 'copilot', 'gemini'],
  alwaysHide: [],
  people: [],
  confirmBeforeSend: true,
  allowSendAsWritten: true,
  restoreOnScreen: true,
  receipts: true,
  keepDays: 30,
  staffLabel: '',
});

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length > 0) : null;

/** Read one policy layer. Unknown fields are ignored; a field of the wrong type is as if it were absent. */
export function readPolicy(raw: unknown, base: Readonly<Policy> = DEFAULT_POLICY): Policy {
  const p: Policy = { ...base, sites: [...base.sites], alwaysHide: [...base.alwaysHide], people: [...base.people] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
  const r = raw as Record<string, unknown>;
  const sites = strings(r['sites']);
  if (sites) p.sites = sites;
  const hide = strings(r['alwaysHide']);
  if (hide) p.alwaysHide = hide;
  const people = strings(r['people']);
  if (people) p.people = people;
  for (const k of ['confirmBeforeSend', 'allowSendAsWritten', 'restoreOnScreen', 'receipts'] as const) {
    if (typeof r[k] === 'boolean') p[k] = r[k];
  }
  if (typeof r['keepDays'] === 'number' && Number.isFinite(r['keepDays']) && r['keepDays'] >= 0) p.keepDays = r['keepDays'];
  if (typeof r['staffLabel'] === 'string') p.staffLabel = r['staffLabel'].trim();
  return p;
}

/** The packed file first, then the managed policy over it. */
export const mergePolicy = (packed: unknown, managed: unknown): Policy => readPolicy(managed, readPolicy(packed));

import { chatgpt } from './sites/chatgpt.ts';
import { copilot } from './sites/copilot.ts';
import { gemini } from './sites/gemini.ts';
import { local } from './sites/local.ts';
import type { SiteDef } from './sites/types.ts';

export type { SiteDef };
export const SITES: readonly SiteDef[] = [chatgpt, copilot, gemini, local];

/** The site definition for a page, if the company's policy covers it. */
export function siteFor(host: string, path: string, covered: readonly string[]): SiteDef | null {
  const site = SITES.find((s) => s.hosts.includes(host.toLowerCase()) && (!s.path || path.startsWith(s.path)));
  return site && covered.includes(site.id) ? site : null;
}

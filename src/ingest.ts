/**
 * Turn files people already have into vault notes, on the device.
 *
 * Pure: it takes text that was read locally and returns note drafts. It never
 * reads files or the network itself, so the browser build and the desktop run
 * the same parser, and a test can prove what a given export becomes.
 *
 * Formats:
 *  - WhatsApp chat exports (Android and iPhone, English or Arabic locale,
 *    Latin or Arabic-Indic digits): one note per day of conversation.
 *  - Plain text and Markdown: one note per heading, or one note per file.
 *  - PDF: the caller extracts the text layer (src/pdf.ts, web/app/lib/pdf.js)
 *    and passes it here; one note per file.
 */

export interface NoteDraft {
  title: string;
  body: string;
}

export type Format = 'whatsapp' | 'text' | 'pdf';

export interface Ingested {
  format: Format;
  notes: NoteDraft[];
  /** Why nothing, or less than expected, came out. Shown to the owner as is. */
  warnings: string[];
}

function clean(s: string): string {
  return s
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200E\u200F\u202A-\u202E]/g, '');
}

const digits = (s: string): string => s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => String((c.charCodeAt(0) & 0xf) % 10));

function baseName(fileName: string): string {
  return (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[^.]+$/, '').trim();
}

// ---------------------------------------------------------------- WhatsApp

/**
 * One message line. Android:  12/10/2026, 14:03 - Sami Haddad: text
 *                   iPhone:   [12/10/2026, 14:03:22] Sami Haddad: text
 * The time may carry AM/PM, ص/م, and a narrow no-break space.
 */
const WA_HEAD = /^\[?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})[,،]?\s+(\d{1,2}:\d{2})(?::\d{2})?(?:\s*([AaPp])\.?[Mm]\.?|\s*([صم]))?\]?\s*(?:-\s*)?/;
const WA_OMITTED = /^(?:<[^>]*omitted>|(?:image|video|audio|sticker|GIF|document) omitted|<Media omitted>|null|This message was deleted|You deleted this message|تم حذف هذه الرسالة|<تم استبعاد الوسائط>)$/i;

function waTime(hm: string, latin?: string, arabic?: string): string {
  const [h = '0', m = '00'] = hm.split(':');
  let hour = Number(h);
  const pm = latin ? latin.toLowerCase() === 'p' : arabic === 'م';
  const am = latin ? latin.toLowerCase() === 'a' : arabic === 'ص';
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${m}`;
}

export function looksLikeWhatsApp(text: string): boolean {
  const lines = clean(text).split('\n').filter((l) => l.trim()).slice(0, 20);
  const heads = lines.filter((l) => WA_HEAD.test(digits(l))).length;
  return lines.length > 0 && heads / lines.length >= 0.5;
}

/** "WhatsApp Chat with Sami Haddad.txt" -> "Sami Haddad"; Arabic "محادثة واتساب مع سامي" -> "سامي". */
export function chatNameFrom(fileName: string): string {
  const b = baseName(fileName);
  const m = /(?:WhatsApp Chat (?:with|-)\s*|محادثة واتساب مع\s*)(.+)$/i.exec(b);
  return (m?.[1] ?? b).trim() || 'WhatsApp chat';
}

export function parseWhatsApp(text: string, chatName: string): Ingested {
  const days = new Map<string, string[]>();
  let current: string[] | null = null;
  let messages = 0;
  let skipped = 0;
  for (const raw of clean(text).split('\n')) {
    const line = digits(raw);
    const head = WA_HEAD.exec(line);
    if (!head) {
      // A message that runs over several lines.
      if (current && raw.trim()) current[current.length - 1] += `\n${raw.trim()}`;
      continue;
    }
    const rest = raw.slice(head[0].length);
    const colon = rest.indexOf(': ');
    if (colon <= 0) {
      // "Messages and calls are end-to-end encrypted", "Sami added Nour": not a message.
      current = null;
      continue;
    }
    const who = rest.slice(0, colon).trim();
    const said = rest.slice(colon + 2).trim();
    if (!said || WA_OMITTED.test(said)) {
      skipped += 1;
      current = null;
      continue;
    }
    const day = head[1]!;
    let list = days.get(day);
    if (!list) {
      list = [];
      days.set(day, list);
    }
    list.push(`${waTime(head[2]!, head[3], head[4])} ${who}: ${said}`);
    current = list;
    messages += 1;
  }
  const notes = [...days].map(([day, lines]) => ({ title: `WhatsApp with ${chatName}, ${day}`, body: lines.join('\n') }));
  const warnings: string[] = [];
  if (messages === 0) warnings.push('No messages were found. Export the chat from WhatsApp as a .txt file, without media.');
  if (skipped > 0) warnings.push(`${String(skipped)} media or deleted messages were left out. Only text is imported.`);
  return { format: 'whatsapp', notes, warnings };
}

// ---------------------------------------------------------------- text

/** Markdown sections become notes; a file with no headings is one note. */
export function parseText(text: string, fileName: string): Ingested {
  const body = clean(text).trim();
  const title = baseName(fileName) || 'Imported note';
  if (!body) return { format: 'text', notes: [], warnings: ['The file is empty.'] };
  const parts = body.split(/^(?=#{1,3}\s)/m).map((p) => p.trim()).filter(Boolean);
  const hasHeadings = parts.some((p) => /^#{1,3}\s/.test(p));
  if (!hasHeadings) return { format: 'text', notes: [{ title, body }], warnings: [] };
  const notes: NoteDraft[] = [];
  for (const p of parts) {
    const m = /^#{1,3}\s+(.+)\n?([\s\S]*)$/.exec(p);
    if (!m) {
      notes.push({ title, body: p });
      continue;
    }
    const text2 = (m[2] ?? '').trim();
    if (text2) notes.push({ title: `${title}: ${m[1]!.trim()}`, body: text2 });
  }
  return { format: 'text', notes, warnings: [] };
}

// ---------------------------------------------------------------- pdf

/** One piece of text as a PDF places it: x, y of its baseline start, width and height, in page units. */
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const AR_LETTER = /[\u0600-\u065F\u066A-\u06EF\u06FA-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LTR_BIT = /[0-9\u0660-\u0669\u06F0-\u06F9A-Za-z]/;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

/**
 * Put a page's text back in reading order. Many PDFs, Chrome's among them,
 * draw Arabic one glyph at a time from left to right, in presentation forms
 * (ﺳ ﺎ ﻣ), so a naive read comes out reversed, spaced and unsearchable. Lines
 * are rebuilt from positions; a line that is mostly Arabic is read right to
 * left, with runs of digits or Latin inside it kept left to right; and the
 * glyph forms are folded back to letters.
 */
export function layoutPdfItems(items: PdfItem[]): string {
  const bits = items.filter((b) => b.str.length > 0);
  const lines: PdfItem[][] = [];
  for (const b of [...bits].sort((a, c) => c.y - a.y)) {
    const line = lines.find((l) => Math.abs(l[0]!.y - b.y) < Math.max(2, 0.5 * (b.h || l[0]!.h)));
    if (line) line.push(b);
    else lines.push([b]);
  }
  const out: string[] = [];
  for (const line of lines) {
    line.sort((a, c) => a.x - c.x);
    // Visual order, left to right, with a space wherever the gap is a word gap.
    const vis: { s: string; gapBefore: boolean }[] = line.map((b, i) => {
      const prev = line[i - 1];
      const gap = prev ? b.x - (prev.x + prev.w) : 0;
      return { s: b.str, gapBefore: !!prev && gap > 0.18 * (b.h || prev.h || 10) };
    });
    const text = line.map((b) => b.str).join('');
    const arabic = [...text].filter((c) => AR_LETTER.test(c)).length;
    const latin = [...text].filter((c) => /[A-Za-z]/.test(c)).length;
    let s: string;
    if (arabic > latin) {
      // Right to left: walk from the right, but keep each left-to-right run in its own order.
      const pieces: string[] = [];
      let i = vis.length - 1;
      while (i >= 0) {
        const v = vis[i]!;
        if (LTR_BIT.test(v.s) && !AR_LETTER.test(v.s)) {
          let j = i;
          while (j - 1 >= 0 && !vis[j]!.gapBefore && !AR_LETTER.test(vis[j - 1]!.s) && (LTR_BIT.test(vis[j - 1]!.s) || /^[.,:/%-]$/.test(vis[j - 1]!.s))) j -= 1;
          const run = vis.slice(j, i + 1);
          pieces.push(run.map((r, k) => (k > 0 && r.gapBefore ? ' ' : '') + r.s).join(''));
          if (vis[j]!.gapBefore) pieces.push(' ');
          i = j - 1;
        } else {
          // pdf.js already gives a multi-letter right-to-left item in reading order; a lone bracket glyph is mirrored.
          pieces.push(v.s.length === 1 ? (MIRROR[v.s] ?? v.s) : v.s);
          if (v.gapBefore) pieces.push(' ');
          i -= 1;
        }
      }
      s = pieces.join('');
    } else {
      s = vis.map((v) => (v.gapBefore ? ' ' : '') + v.s).join('');
    }
    s = s.normalize('NFKC').replace(/ی/g, 'ي').replace(/ک/g, 'ك').replace(/ھ/g, 'ه').replace(/[ \t]+/g, ' ').trim();
    if (s) out.push(s);
  }
  return out.join('\n');
}

/** Pages of text from a PDF's text layer become one note. */
export function parsePdfText(pages: string[], fileName: string): Ingested {
  const body = pages
    .map((p) => clean(p).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean)
    .join('\n\n');
  const title = baseName(fileName) || 'Imported PDF';
  if (!body) {
    return { format: 'pdf', notes: [], warnings: [`${title} has no text layer. It is probably a scan or a photo; text recognition is not built yet, so nothing was imported.`] };
  }
  return { format: 'pdf', notes: [{ title, body }], warnings: [] };
}

// ---------------------------------------------------------------- one entry point

/** Decide the format from the name and the content, for anything that is already text. */
export function ingestText(text: string, fileName: string): Ingested {
  if (/\.pdf$/i.test(fileName)) throw new Error('A PDF must be read with the PDF reader first, then passed to parsePdfText.');
  if (looksLikeWhatsApp(text)) return parseWhatsApp(text, chatNameFrom(fileName));
  return parseText(text, fileName);
}

/** Drop drafts already in the vault, so importing the same file twice adds nothing. */
export function newOnly(drafts: NoteDraft[], existing: { title: string; body: string }[]): NoteDraft[] {
  const seen = new Set(existing.map((n) => `${n.title}\u0000${n.body}`));
  return drafts.filter((d) => {
    const k = `${d.title}\u0000${d.body}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Read the text layer of a PDF on this machine, for import into the vault.
 * pdf.js is given the bytes, never a URL, and runs without a worker thread,
 * fonts or canvas: text extraction needs none of them.
 *
 * pdf.js looks for an optional native canvas package when it loads and warns
 * when it is missing. It is left out on purpose (no native code), so those
 * load-time warnings are dropped and nothing else is.
 */

import { layoutPdfItems, type PdfItem } from './ingest.ts';

interface TextBit {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | null = null;

function load(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    const log = console.log;
    const warn = console.warn;
    const quiet = (fn: (...a: unknown[]) => void) => (...a: unknown[]): void => {
      if (typeof a[0] === 'string' && /^Warning: Cannot (?:load "@napi-rs\/canvas"|polyfill)/.test(a[0])) return;
      fn(...a);
    };
    console.log = quiet(log);
    console.warn = quiet(warn);
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      console.log = log;
      console.warn = warn;
    }
  })();
  return pdfjs;
}

export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const { getDocument } = await load();
  const task = getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const bit of content.items as TextBit[]) {
        if (typeof bit.str !== 'string' || !bit.transform) continue;
        items.push({ str: bit.str, x: bit.transform[4] ?? 0, y: bit.transform[5] ?? 0, w: bit.width ?? 0, h: bit.height || Math.abs(bit.transform[3] ?? 0) });
      }
      pages.push(layoutPdfItems(items));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

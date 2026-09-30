// Read the text layer of a PDF in this tab, for import into the vault.
// pdf.js is vendored and served from this origin; it is given the bytes, never a URL.
import { layoutPdfItems } from './core/ingest.js';

let pdfjs = null;
async function load() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export async function pdfPages(bytes) {
  const { getDocument } = await load();
  const task = getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items = content.items
        .filter((b) => typeof b.str === 'string' && b.transform)
        .map((b) => ({ str: b.str, x: b.transform[4], y: b.transform[5], w: b.width ?? 0, h: b.height || Math.abs(b.transform[3]) }));
      pages.push(layoutPdfItems(items));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

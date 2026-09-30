/**
 * Import files from this machine into the vault. Reads the file here, parses it
 * with the shared parser, and seals each note. Nothing is sent anywhere: an
 * import writes no ledger entry, because nothing left the device.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { type Ingested, ingestText, newOnly, parsePdfText } from './ingest.ts';
import { pdfPages } from './pdf.ts';
import { addNote, type OpenVault, readNotes } from './vault.ts';

export interface ImportResult {
  file: string;
  format: Ingested['format'];
  added: number;
  alreadyThere: number;
  warnings: string[];
}

export async function readForImport(path: string): Promise<Ingested> {
  const name = basename(path);
  const bytes = await readFile(path);
  if (/\.pdf$/i.test(name)) return parsePdfText(await pdfPages(new Uint8Array(bytes)), name);
  return ingestText(bytes.toString('utf8'), name);
}

export async function importFile(v: OpenVault, path: string): Promise<ImportResult> {
  const parsed = await readForImport(path);
  const fresh = newOnly(parsed.notes, readNotes(v));
  for (const d of fresh) await addNote(v, d.title, d.body);
  return { file: basename(path), format: parsed.format, added: fresh.length, alreadyThere: parsed.notes.length - fresh.length, warnings: parsed.warnings };
}

import { resolve } from 'node:path';

/** Where the vault, receipts and ledger live. Never inside the repo's tracked files. */
export function noaiHome(): string {
  return resolve(process.env.NOAI_HOME ?? '.noai');
}

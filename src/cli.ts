/**
 * noai init | seed | add <title> <text> | import <file...> | remember <fact> | people | ask <question> | tape | verify | serve
 *
 * The passphrase comes from NOAI_PASSPHRASE. The Nebius key from NEBIUS_API_KEY
 * (npm scripts load .env, which is gitignored).
 */
import { readFile } from 'node:fs/promises';
import { ask, remember } from './agent.ts';
import { configFromEnv } from './gate.ts';
import { importFile } from './importer.ts';
import { noaiHome } from './home.ts';
import { knownPeople } from './people.ts';
import { readLedger, readReceipts, verifyLedger } from './ledger.ts';
import { addNote, closeVault, createVault, openVault, readNotes, signerFingerprint } from './vault.ts';

const [cmd, ...args] = process.argv.slice(2);
const root = noaiHome();

function passphrase(): string {
  const p = process.env.NOAI_PASSPHRASE;
  if (!p) throw new Error('Set NOAI_PASSPHRASE to unlock the vault.');
  return p;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'init': {
      const v = await createVault(root, passphrase());
      console.log(`Vault created at ${v.path}\nDevice key ${signerFingerprint(v.data.device.publicKey)}`);
      closeVault(v);
      return;
    }
    case 'seed': {
      const v = await openVault(root, passphrase());
      const notes = JSON.parse(await readFile(new URL('../demo/notes.json', import.meta.url), 'utf8')) as { title: string; body: string }[];
      for (const n of notes) await addNote(v, n.title, n.body);
      console.log(`Sealed ${String(notes.length)} demo notes into the vault.`);
      closeVault(v);
      return;
    }
    case 'add': {
      const [title, ...body] = args;
      if (!title || body.length === 0) throw new Error('Usage: noai add <title> <text>');
      const v = await openVault(root, passphrase());
      const n = await addNote(v, title, body.join(' '));
      console.log(`Sealed note ${n.id}.`);
      closeVault(v);
      return;
    }
    case 'import': {
      if (args.length === 0) throw new Error('Usage: noai import <file...>  (WhatsApp .txt export, contacts .vcf, .txt, .md or .pdf)');
      const v = await openVault(root, passphrase());
      for (const f of args) {
        const r = await importFile(v, f);
        const dup = r.alreadyThere ? `, ${String(r.alreadyThere)} already in the vault` : '';
        console.log(`${r.file}: ${r.format}, sealed ${String(r.added)} note(s)${dup}.`);
        for (const w of r.warnings) console.log(`  ${w}`);
      }
      console.log('Nothing was sent.');
      closeVault(v);
      return;
    }
    case 'remember': {
      const fact = args.join(' ');
      if (!fact) throw new Error('Usage: noai remember <fact>');
      const v = await openVault(root, passphrase());
      const r = await remember(v, fact);
      console.log(`Sealed memory ${r.note.id}. Nothing was sent.`);
      closeVault(v);
      return;
    }
    case 'people': {
      // Printed here, on this machine, for the owner to check. Nothing is sent.
      const v = await openVault(root, passphrase());
      const { people, same } = knownPeople(readNotes(v));
      console.log(`${String(people.length)} people named in the vault are always hidden as [PERSON_n] before anything is sent:`);
      for (const p of people) console.log(`  ${p}`);
      if (same.length) console.log('Other names you taught, hidden as the same person:');
      for (const [other, name] of same) console.log(`  ${other} = ${name}`);
      console.log('A name not on this list is hidden only when the text points at it. Import contacts (.vcf) to add people, or teach a spelling: remember that Mhmd is short for Mohammed Haddad.');
      closeVault(v);
      return;
    }
    case 'ask': {
      const question = args.join(' ');
      if (!question) throw new Error('Usage: noai ask <question>');
      const v = await openVault(root, passphrase());
      const r = await ask(v, configFromEnv(root), question);
      console.log(`\n${r.answer}\n`);
      console.log('--- what left this device ---');
      console.log(r.disclosed);
      console.log('--- receipt ---');
      console.log(JSON.stringify(r.signed.receipt, null, 2));
      console.log(`chain entry ${String(r.entry.seq)}  ${r.entry.entryHash.slice(0, 16)}  ${String(r.ms)} ms  retrieval ${r.retriever}`);
      for (const m of r.remembered) console.log(`remembered: ${m.body}`);
      closeVault(v);
      return;
    }
    case 'tape': {
      for (const e of await readLedger(root)) {
        console.log(`#${String(e.seq)}  ${e.at}  ${e.model}  ${String(e.payloadBytes)} B  ${e.entryHash.slice(0, 16)}`);
      }
      return;
    }
    case 'verify': {
      const verdict = verifyLedger(await readLedger(root), await readReceipts(root));
      console.log(`${verdict.valid ? 'VALID' : 'BROKEN'}: ${verdict.reason}`);
      process.exitCode = verdict.valid ? 0 : 1;
      return;
    }
    case 'serve': {
      await import('./server.ts');
      return;
    }
    default:
      console.log('noai init | seed | add <title> <text> | import <file...> | remember <fact> | people | ask <question> | tape | verify | serve');
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

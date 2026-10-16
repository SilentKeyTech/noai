/**
 * npm run staff -- add <name> [--admin]   (an admin's password comes from NOAI_ADMIN_PASSWORD)
 * npm run staff -- list
 * npm run staff -- revoke <name>
 * npm run staff -- set <name> [--pause | --resume] [--models a,b | --all-models] [--hide-real | --show-real]
 *
 * A token is printed once, when the person is added. It is not stored.
 */
import { noaiHome } from './home.ts';
import { accessOf, addStaff, readStaff, revokeStaff, setAccess, type StaffRecord } from './staff.ts';

const [cmd, name, ...flags] = process.argv.slice(2);
const root = noaiHome();

const describe = (s: StaffRecord): string => {
  const a = accessOf(s);
  return [a.paused ? 'paused' : 'AI on', a.models ? `models ${a.models.join(',')}` : 'all models', a.showReal ? 'sees real values' : 'sees placeholders only'].join(', ');
};

async function main(): Promise<void> {
  switch (cmd) {
    case 'add': {
      if (!name) throw new Error('Who? npm run staff -- add <name> [--admin]');
      const admin = flags.includes('--admin');
      const { token } = await addStaff(root, name, admin ? 'admin' : 'staff', process.env.NOAI_ADMIN_PASSWORD);
      console.log(`${name} added${admin ? ' as an admin (can read the receipts page)' : ''}.`);
      console.log(`Token, shown once: ${token}`);
      console.log('Give it to them as their API key. It cannot be shown again; revoke and re-add to replace it.');
      return;
    }
    case 'list': {
      for (const s of await readStaff(root)) console.log(`${s.name.padEnd(20)} ${s.role.padEnd(6)} ${s.revokedAt ? `revoked ${s.revokedAt}` : `active, ${describe(s)}`}`);
      return;
    }
    case 'revoke': {
      if (!name) throw new Error('Who? npm run staff -- revoke <name>');
      console.log((await revokeStaff(root, name)) ? `${name} revoked. Their token stops working on their next call.` : `${name} is not an active person.`);
      return;
    }
    case 'set': {
      if (!name) throw new Error('Who? npm run staff -- set <name> [--pause | --resume] [--models a,b | --all-models] [--hide-real | --show-real]');
      const patch: Parameters<typeof setAccess>[2] = {};
      if (flags.includes('--pause')) patch.paused = true;
      if (flags.includes('--resume')) patch.paused = false;
      if (flags.includes('--hide-real')) patch.showReal = false;
      if (flags.includes('--show-real')) patch.showReal = true;
      if (flags.includes('--all-models')) patch.models = null;
      const m = flags.indexOf('--models');
      if (m >= 0) {
        const list = flags[m + 1];
        if (!list || list.startsWith('--')) throw new Error('--models needs a comma-separated list of model ids.');
        patch.models = list.split(',');
      }
      if (!Object.keys(patch).length) throw new Error('Nothing to change. Use --pause, --resume, --models a,b, --all-models, --hide-real or --show-real.');
      const who = await setAccess(root, name, patch);
      console.log(who ? `${name}: ${describe(who)}. Takes effect on their next call.` : `${name} is not an active person.`);
      return;
    }
    default:
      throw new Error('npm run staff -- add <name> [--admin] | list | revoke <name> | set <name> [options]');
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

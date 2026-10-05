/**
 * npm run staff -- add <name> [--admin]   (an admin's password comes from NOAI_ADMIN_PASSWORD)
 * npm run staff -- list
 * npm run staff -- revoke <name>
 *
 * A token is printed once, when the person is added. It is not stored.
 */
import { noaiHome } from './home.ts';
import { addStaff, readStaff, revokeStaff } from './staff.ts';

const [cmd, name, ...flags] = process.argv.slice(2);
const root = noaiHome();

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
      for (const s of await readStaff(root)) console.log(`${s.name.padEnd(20)} ${s.role.padEnd(6)} ${s.revokedAt ? `revoked ${s.revokedAt}` : 'active'}`);
      return;
    }
    case 'revoke': {
      if (!name) throw new Error('Who? npm run staff -- revoke <name>');
      console.log((await revokeStaff(root, name)) ? `${name} revoked. Their token stops working on their next call.` : `${name} is not an active person.`);
      return;
    }
    default:
      throw new Error('npm run staff -- add <name> [--admin] | list | revoke <name>');
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

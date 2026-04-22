import type { Kysely } from 'kysely';

// deno-lint-ignore no-explicit-any
const stubPool = null as any as Kysely<any>;

const database = {
  pools: {
    readOnly: stubPool,
    fullAccess: stubPool,
  },
};

export default database;

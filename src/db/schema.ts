// ---------------------------------------------------------------------------
// Kysely type bindings for the Supabase tables this library reads.
//
// Deno notes:
//   - `npm:kysely@^0.28.9` (see deno.json) pulls the package from npm on
//     first load and caches it under DENO_DIR. Deno resolves CJS ↔ ESM
//     interop transparently, so the same API surface works here as in Node.
//   - For Postgres drivers in Deno, a common pairing is
//     `kysely-postgres-js` with `postgres.js`, both available via npm: .
//     The driver instantiation is intentionally left out of this file so
//     the schema types can be imported from anywhere without triggering a
//     DB connection.
// ---------------------------------------------------------------------------

import type { Generated, ColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Numeric = string;

export interface Stars {
  id: Generated<number>;
  name: string;
  rewards_codes_range_from: number | null;
  rewards_codes_range_to: number | null;
}

export interface Networks {
  id: Generated<number>;
  name: string;
}

export interface Addresses {
  id: Generated<number>;
  internal_name: Generated<string | null>;
  network_id: number | null;
  public_key: Generated<string | null>;
}

export interface Tokens {
  address_id: number | null;
  coingecko_id: string | null;
  created_at: Generated<Timestamp>;
  id: Generated<number>;
  name: string;
  symbol: string;
  track_price: Generated<boolean>;
  updated_at: Generated<Timestamp>;
}

export interface StarAllocationSystems {
  alm_direct: Numeric;
  alm_proxy_contract: string | null;
  created_at: Generated<Timestamp>;
  datetime: Timestamp;
  debt: Generated<Numeric | null>;
  id: Generated<number>;
  network_id: number;
  psm3_contract: string | null;
  psm3_share: Numeric;
  star_id: number;
  total: Numeric;
  updated_at: Generated<Timestamp>;
}

export interface StarAllocationSystemAssets {
  created_at: Generated<Timestamp>;
  datetime: Timestamp;
  id: Generated<number>;
  price_usd: Numeric | null;
  quantity: Numeric | null;
  source: Generated<string>;
  star_allocation_system_id: number;
  token_id: number;
  total_usd: Numeric;
  underlying_token_id: number | null;
  underlying_token_price_usd: Numeric | null;
  underlying_token_quantity: Numeric | null;
  updated_at: Generated<Timestamp>;
  wallet_id: number | null;
}

export interface SsrEventIntegrationBoost {
  block_number: string;
  contract_address: string;
  data: number | null;
  id: Generated<number>;
  raw_ssr: string | null;
  timestamp: Timestamp;
  what: string | null;
}

export interface SupabaseDB {
  stars: Stars;
  networks: Networks;
  addresses: Addresses;
  tokens: Tokens;
  star_allocation_systems: StarAllocationSystems;
  star_allocation_system_assets: StarAllocationSystemAssets;
  ssr_event_integration_boost: SsrEventIntegrationBoost;
}

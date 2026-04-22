// ---------------------------------------------------------------------------
// Morpho vault utilization reader.
//
// Morpho exposes a hosted GraphQL API (api.morpho.org) that already returns
// weighted utilization across every market a vault is exposed to, so we use
// that instead of chaining on-chain reads. This means NO Alchemy CU cost for
// these vaults — the data comes from Morpho's indexer, which is cheaper than
// doing the equivalent computation via `eth_getLogs` + per-market reads.
//
// Deno notes:
//   • `fetch` is a built-in, standards-compliant global. No import needed.
//   • `--allow-net=api.morpho.org` is the minimum network permission to run
//     this file in isolation.
// ---------------------------------------------------------------------------

import BigNumber from 'bignumber.js';

export interface MorphoUtilizationData {
  address: string;
  symbol: string;
  totalAssetsUsd: BigNumber;
  weightedUtilization: number;
  idleRatio: number;
}

interface AllocationData {
  supplyAssetsUsd: number;
  market: {
    uniqueKey: string;
    state?: {
      utilization: number;
    };
  };
}

interface VaultStateData {
  totalAssetsUsd: number;
  allocation: AllocationData[];
}

interface VaultStateResponse {
  data: {
    vaultByAddress: {
      address: string;
      symbol: string;
      state?: VaultStateData;
    } | null;
  };
}

interface DataPoint {
  x: number;
  y: number | null;
}

interface VaultHistoricalResponse {
  data: {
    vaultByAddress: {
      address: string;
      symbol: string;
      historicalState?: {
        allocation?: Array<{
          market?: {
            historicalState?: {
              utilization?: DataPoint[];
            };
          };
          supplyAssetsUsd?: DataPoint[];
        }>;
      };
    } | null;
  };
}

function findClosestDataPoint(
  pts: DataPoint[],
  t: number,
): number | null {
  if (pts.length === 0) return null;
  let c = pts[0];
  let md = Math.abs(c.x - t);
  for (let i = 1; i < pts.length; i++) {
    const d = Math.abs(pts[i].x - t);
    if (d < md) {
      md = d;
      c = pts[i];
    }
  }
  return c.y;
}

async function fetchHistoricalUtilization(
  vaultAddress: string,
  chainId: number,
  atTimestamp: number,
): Promise<MorphoUtilizationData | null> {
  // Ask Morpho for a ±1 day window of hourly datapoints around the target
  // timestamp and pick the closest one.
  const ds = 86400;
  const st = atTimestamp - ds;
  const et = atTimestamp + ds;

  const q = {
    query: `{
      vaultByAddress(address: "${vaultAddress}", chainId: ${chainId}) {
        address
        symbol
        historicalState {
          allocation {
            market {
              uniqueKey
              historicalState {
                utilization(options: { startTimestamp: ${st}, endTimestamp: ${et}, interval: HOUR }) {
                  x
                  y
                }
              }
            }
            supplyAssetsUsd(options: { startTimestamp: ${st}, endTimestamp: ${et}, interval: HOUR }) {
              x
              y
            }
          }
        }
      }
    }`,
  };

  const r = await fetch('https://api.morpho.org/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(q),
  });

  if (!r.ok) {
    console.warn(
      `[Morpho API] HTTP error fetching historical utilization for ${vaultAddress}: ${r.status}`,
    );
    return null;
  }

  const d: VaultHistoricalResponse = await r.json();
  const v = d.data?.vaultByAddress;
  const al = v?.historicalState?.allocation ?? [];

  if (al.length === 0) {
    console.warn(
      `[Morpho API] No historical state data for vault ${vaultAddress}`,
    );
    return null;
  }

  let tvs = 0;
  let wu = 0;

  for (const a of al) {
    const sp = a.supplyAssetsUsd ?? [];
    const up = a.market?.historicalState?.utilization ?? [];

    const s = findClosestDataPoint(sp, atTimestamp);
    const u = findClosestDataPoint(up, atTimestamp);

    if (s !== null && s > 0 && u !== null) {
      tvs += s;
      wu += s * u;
    }
  }

  const au = tvs > 0 ? wu / tvs : 0;
  const ir = 1 - au;

  console.log(
    `[Morpho] ${v!.symbol} historical weighted utilization: ${(au * 100).toFixed(2)}%, idle ratio: ${(ir * 100).toFixed(2)}%`,
  );

  return {
    address: vaultAddress,
    symbol: v!.symbol,
    totalAssetsUsd: new BigNumber(tvs),
    weightedUtilization: au,
    idleRatio: ir,
  };
}

export async function getMorphoVaultUtilization(
  vaultAddress: string,
  chainId: number = 1,
  atTimestamp?: number,
): Promise<MorphoUtilizationData | null> {
  try {
    if (atTimestamp !== undefined) {
      return fetchHistoricalUtilization(vaultAddress, chainId, atTimestamp);
    }

    const vq = `
      query {
        vaultByAddress(address: "${vaultAddress}", chainId: ${chainId}) {
          address
          symbol
          state {
            totalAssetsUsd
            allocation {
              supplyAssetsUsd
              market {
                uniqueKey
                state {
                  utilization
                }
              }
            }
          }
        }
      }
    `;

    const r = await fetch('https://api.morpho.org/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: vq }),
    });

    if (!r.ok) {
      console.warn(
        `[Morpho API] HTTP error fetching utilization for ${vaultAddress}: ${r.status}`,
      );
      return null;
    }

    const d: VaultStateResponse = await r.json();
    const v = d.data?.vaultByAddress;
    const st = v?.state;

    if (!st) {
      console.warn(`[Morpho API] No state data for vault ${vaultAddress}`);
      return null;
    }

    const al = st.allocation || [];
    const tau = new BigNumber(st.totalAssetsUsd);

    let tvs = 0;
    let wu = 0;

    for (const a of al) {
      const vs = a.supplyAssetsUsd || 0;
      const mu = a.market?.state?.utilization || 0;
      tvs += vs;
      wu += vs * mu;
    }

    const au = tvs > 0 ? wu / tvs : 0;
    const ir = 1 - au;

    console.log(
      `[Morpho] ${v!.symbol} weighted utilization: ${(au * 100).toFixed(2)}%, idle ratio: ${(ir * 100).toFixed(2)}%`,
    );

    return {
      address: vaultAddress,
      symbol: v!.symbol,
      totalAssetsUsd: tau,
      weightedUtilization: au,
      idleRatio: ir,
    };
  } catch (err) {
    console.error(
      `[Morpho] Error fetching utilization for ${vaultAddress}:`,
      err,
    );
    return null;
  }
}

export async function getAllMorphoUtilizations(
  atTimestamp?: number,
): Promise<Map<string, MorphoUtilizationData>> {
  const res = new Map<string, MorphoUtilizationData>();

  const addrs = [
    '0x73e65dbd630f90604062f6e02fab9138e713edd9',
    '0xe41a0583334f0dc4e023acd0bfef3667f6fe0597',
  ];
  const u = await Promise.all(addrs.map((a) => getMorphoVaultUtilization(a, 1, atTimestamp)));

  for (let i = 0; i < addrs.length; i++) {
    const d = u[i];
    if (d) res.set(addrs[i].toLowerCase(), d);
  }

  return res;
}

export function isMorphoVault(address: string): boolean {
  const a = address.toLowerCase();
  return a === '0x73e65dbd630f90604062f6e02fab9138e713edd9' ||
    a === '0xe41a0583334f0dc4e023acd0bfef3667f6fe0597';
}

// ---------------------------------------------------------------------------
// Aave v3 utilization reader (aToken supply vs. outstanding debt).
//
// We talk to three Aave contracts at a historical block:
//   1. the aToken        (supply side)
//   2. the variable debt (primary borrow side in Aave v3)
//   3. the stable debt   (legacy borrow side)
//
// That's five `eth_call`s per asset, each ~26 CU on Alchemy. Using a single
// Promise.all (below) lets ethers fire them in parallel; Alchemy serves them
// concurrently from a single TCP connection.
//
// Historical reads: every call threads `{ blockTag: bt }` where `bt` is a
// block number resolved by support/block.ts. This is Alchemy's archive
// access — no special flag, no separate endpoint, you just pass a block
// number and the archive nodes are queried automatically.
// ---------------------------------------------------------------------------

import { Contract } from 'ethers';
import BigNumber from 'bignumber.js';
import { getProvider } from './providers.ts';
import { findBlockByTimestamp } from './block.ts';
import type { Chain } from '../constants.ts';

const POOL_ABI = [
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
];

const ATOKEN_ABI = [
  'function totalSupply() view returns (uint256)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
];

const DEBT_TOKEN_ABI = ['function totalSupply() view returns (uint256)'];

export interface AaveUtilizationData {
  aTokenAddress: string;
  chain: string;
  utilization: number;
  idleRatio: number;
}

export async function getAaveUtilization(
  aTokenAddress: string,
  chain: string,
  atTimestamp: number,
): Promise<AaveUtilizationData | null> {
  const fp = chain === 'ethereum'
    ? '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
    : chain === 'base'
    ? '0xa238dd80c259a72e81d7e4664a9801593f98d1c5'
    : chain === 'arbitrum' || chain === 'avalanche'
    ? '0x794a61358d6845594f94dc1db02a252b5b4814ad'
    : null;
  if (!fp) return null;

  try {
    const p = getProvider(chain as Chain);
    const bt = await findBlockByTimestamp(p, atTimestamp, chain as Chain);

    const at = new Contract(aTokenAddress, ATOKEN_ABI, p);

    // Many aTokens expose POOL() that returns the Pool they were deployed
    // against. If that read fails, fall back to the chain-default pool.
    let pa = fp;
    try {
      pa = await at.POOL({ blockTag: bt });
    } catch {
      // use the fallback pool
    }

    const u = await at.UNDERLYING_ASSET_ADDRESS({
      blockTag: bt,
    });

    const pc = new Contract(pa, POOL_ABI, p);
    const rd = await pc.getReserveData(u, {
      blockTag: bt,
    });

    const vd = new Contract(
      rd.variableDebtTokenAddress,
      DEBT_TOKEN_ABI,
      p,
    );
    const sd = new Contract(
      rd.stableDebtTokenAddress,
      DEBT_TOKEN_ABI,
      p,
    );

    // Three reads, one round-trip per call. Alchemy bills ~26 CU each.
    const [ts, vr, sr] = await Promise.all([
      at.totalSupply({ blockTag: bt }),
      vd.totalSupply({ blockTag: bt }),
      sd.totalSupply({ blockTag: bt }),
    ]);

    const tot = new BigNumber(ts.toString());
    const tb = new BigNumber(vr.toString()).plus(sr.toString());

    const util = tot.gt(0) ? tb.div(tot).toNumber() : 0;
    const ir = 1 - util;

    return {
      aTokenAddress,
      chain,
      utilization: util,
      idleRatio: ir,
    };
  } catch {
    return null;
  }
}

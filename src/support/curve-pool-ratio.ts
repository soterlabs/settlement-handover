// ---------------------------------------------------------------------------
// Curve v1 pool balance reader.
//
// For each timestamp we want to know "what fraction of this Curve pool's
// TVL is the target stablecoin?". That's two-to-four `eth_call`s:
//
//   • coins(0), coins(1)       — pool composition (static, cached-friendly)
//   • balances(0), balances(1) — current token balances
//   • decimals() on each coin  — for normalisation
//
// At Alchemy's 26 CU/eth_call, each call costs ~130–180 CU total. The loops
// below fire these concurrently with Promise.all so ethers dispatches them
// in parallel against a single Alchemy endpoint.
// ---------------------------------------------------------------------------

import { Contract } from 'ethers';
import { getProvider } from './providers.ts';
import { findBlockByTimestamp } from './block.ts';
import BigNumber from 'bignumber.js';

const CURVE_POOL_ABI = [
  'function coins(uint256 index) view returns (address)',
  'function balances(uint256 index) view returns (uint256)',
  'function get_virtual_price() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const ERC20_ABI = ['function decimals() view returns (uint8)'];

export interface CurvePoolRatioData {
  poolAddress: string;
  targetTokenAddress: string;
  targetTokenBalance: BigNumber;
  totalPoolValueUsd: BigNumber;
  targetTokenRatio: number;
}

export async function getCurvePoolUsdtRatio(
  poolAddress: string,
  atTimestamp?: number,
): Promise<CurvePoolRatioData | null> {
  if (poolAddress.toLowerCase() !== '0x00836fe54625be242bcfa286207795405ca4fd10') {
    return null;
  }

  try {
    const p = getProvider('ethereum');
    let bt: number | 'latest' = 'latest';

    if (atTimestamp) {
      bt = await findBlockByTimestamp(p, atTimestamp, 'ethereum');
    }

    const pc = new Contract(poolAddress, CURVE_POOL_ABI, p);

    // Fire both coin(i) reads concurrently — ethers opens a persistent
    // connection to Alchemy and multiplexes the POSTs.
    const [c0, c1] = await Promise.all([
      pc.coins(0, { blockTag: bt }),
      pc.coins(1, { blockTag: bt }),
    ]);

    const c0l = String(c0).toLowerCase();
    const c1l = String(c1).toLowerCase();

    let ui: number;
    if (c0l === '0xdac17f958d2ee523a2206206994597c13d831ec7') {
      ui = 0;
    } else if (c1l === '0xdac17f958d2ee523a2206206994597c13d831ec7') {
      ui = 1;
    } else {
      console.error('USDT not found in pool coins');
      return null;
    }

    const [b0, b1] = await Promise.all([
      pc.balances(0, { blockTag: bt }),
      pc.balances(1, { blockTag: bt }),
    ]);

    const uc = new Contract('0xdac17f958d2ee523a2206206994597c13d831ec7', ERC20_ABI, p);
    const oa = ui === 0 ? c1l : c0l;
    const oc = new Contract(oa, ERC20_ABI, p);

    const [ud, od] = await Promise.all([
      uc.decimals({ blockTag: bt }),
      oc.decimals({ blockTag: bt }),
    ]);

    const ubr = ui === 0 ? b0 : b1;
    const obr = ui === 0 ? b1 : b0;

    const ub = new BigNumber(ubr.toString()).dividedBy(
      new BigNumber(10).exponentiatedBy(Number(ud)),
    );
    const ob = new BigNumber(obr.toString()).dividedBy(
      new BigNumber(10).exponentiatedBy(Number(od)),
    );

    const tv = ub.plus(ob);

    const ur = tv.gt(0) ? ub.dividedBy(tv).toNumber() : 0;

    return {
      poolAddress,
      targetTokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      targetTokenBalance: ub,
      totalPoolValueUsd: tv,
      targetTokenRatio: ur,
    };
  } catch (err) {
    console.error(`Error fetching Curve pool ratio for ${poolAddress}:`, err);
    return null;
  }
}

export async function getCurvePoolStablecoinRatio(
  poolAddress: string,
  targetStablecoinAddress: string,
  atTimestamp?: number,
): Promise<CurvePoolRatioData | null> {
  try {
    const p = getProvider('ethereum');
    let bt: number | 'latest' = 'latest';

    if (atTimestamp) {
      bt = await findBlockByTimestamp(p, atTimestamp, 'ethereum');
    }

    const pc = new Contract(poolAddress, CURVE_POOL_ABI, p);
    const tl = targetStablecoinAddress.toLowerCase();

    const [c0, c1] = await Promise.all([
      pc.coins(0, { blockTag: bt }),
      pc.coins(1, { blockTag: bt }),
    ]);

    const c0l = String(c0).toLowerCase();
    const c1l = String(c1).toLowerCase();

    let ti: number;
    if (c0l === tl) {
      ti = 0;
    } else if (c1l === tl) {
      ti = 1;
    } else {
      console.error(
        `Target token ${targetStablecoinAddress} not found in pool ${poolAddress}`,
      );
      return null;
    }

    const [b0, b1] = await Promise.all([
      pc.balances(0, { blockTag: bt }),
      pc.balances(1, { blockTag: bt }),
    ]);

    const tc = new Contract(tl, ERC20_ABI, p);
    const oa = ti === 0 ? c1l : c0l;
    const oc = new Contract(oa, ERC20_ABI, p);

    const [td, od] = await Promise.all([
      tc.decimals({ blockTag: bt }),
      oc.decimals({ blockTag: bt }),
    ]);

    const tbr = ti === 0 ? b0 : b1;
    const obr = ti === 0 ? b1 : b0;

    const tb = new BigNumber(tbr.toString()).dividedBy(
      new BigNumber(10).exponentiatedBy(Number(td)),
    );
    const ob = new BigNumber(obr.toString()).dividedBy(
      new BigNumber(10).exponentiatedBy(Number(od)),
    );

    const tv = tb.plus(ob);

    const tr = tv.gt(0) ? tb.dividedBy(tv).toNumber() : 0;

    return {
      poolAddress,
      targetTokenAddress: tl,
      targetTokenBalance: tb,
      totalPoolValueUsd: tv,
      targetTokenRatio: tr,
    };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === 'BAD_DATA'
    ) {
      return null;
    }
    console.error(`Error fetching Curve pool ratio for ${poolAddress}:`, err);
    return null;
  }
}

export async function getCurvePoolIdleRatio(
  poolAddress: string,
  atTimestamp?: number,
): Promise<{ idleRatio: number } | null> {
  const key = poolAddress.toLowerCase();
  let target: string;
  let symbol: string;
  if (key === '0x00836fe54625be242bcfa286207795405ca4fd10') {
    target = '0xdac17f958d2ee523a2206206994597c13d831ec7';
    symbol = 'USDT';
  } else if (key === '0xa632d59b9b804a956bfaa9b48af3a1b74808fc1f') {
    target = '0x6c3ea9036406852006290770bedfcaba0e23a0e8';
    symbol = 'PYUSD';
  } else {
    return null;
  }

  const d = await getCurvePoolStablecoinRatio(poolAddress, target, atTimestamp);
  if (!d) return null;

  console.log(
    `[Curve] ${symbol} ratio in pool ${poolAddress.slice(0, 10)}...: ${(d.targetTokenRatio * 100).toFixed(2)}%`,
  );

  return { idleRatio: d.targetTokenRatio };
}

export async function getCurvePoolUsdtRatioAtTimestamps(
  poolAddress: string,
  timestamps: number[],
): Promise<Map<number, number>> {
  const res = new Map<number, number>();

  for (const t of timestamps) {
    const d = await getCurvePoolUsdtRatio(poolAddress, t);
    if (d) {
      res.set(t, d.targetTokenRatio);
    }
  }

  return res;
}

// SparkLend (Aave v3 fork) utilization reader. Same ABIs, same CU costs
// as Aave. Historical reads use { blockTag } — Alchemy serves those from
// archive nodes automatically.

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
  'function scaledTotalSupply() view returns (uint256)',
];

const DEBT_TOKEN_ABI = ['function totalSupply() view returns (uint256)'];

export interface UtilizationData {
  address: string;
  underlying: string;
  symbol: string;
  totalSupply: BigNumber;
  totalBorrows: BigNumber;
  utilization: number;
  idleRatio: number;
}

export async function getSparkLendUtilization(
  spTokenAddress: string,
  atTimestamp?: number,
  chain: Chain = 'ethereum',
): Promise<UtilizationData | null> {
  if (chain !== 'ethereum') return null;

  const a = spTokenAddress.toLowerCase();
  let underlying: string;
  let symbol: string;
  if (a === '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f') {
    underlying = '0xdac17f958d2ee523a2206206994597c13d831ec7';
    symbol = 'USDT';
  } else if (a === '0x779224df1c756b4edd899854f32a53e8c2b2ce5d') {
    underlying = '0x6c3ea9036406852006290770bedfcaba0e23a0e8';
    symbol = 'PYUSD';
  } else if (a === '0xc02ab1a5eaa8d1b114ef786d9bde108cd4364359') {
    underlying = '0xdc035d45d973e3ec169d2276ddab16f1e407384f';
    symbol = 'USDS';
  } else if (a === '0x4dedf26112b3ec8ec46e7e31ea5e123490b05b8b') {
    underlying = '0x6b175474e89094c44da98b954eedeac495271d0f';
    symbol = 'DAI';
  } else if (a === '0x377c3bd93f2a2984e1e7be6a5c22c525ed4a4815') {
    underlying = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    symbol = 'USDC';
  } else {
    return null;
  }

  try {
    const p = getProvider(chain);

    // 'latest' routes to hot nodes; a numeric blockTag routes to archive.
    let bt: number | 'latest' = 'latest';
    if (atTimestamp) bt = await findBlockByTimestamp(p, atTimestamp, chain);

    const pc = new Contract('0xc13e21b648a5ee794902342038ff3adab66be987', POOL_ABI, p);

    const rd = await pc.getReserveData(underlying, { blockTag: bt });

    const atc = new Contract(rd.aTokenAddress, ATOKEN_ABI, p);
    const vdc = new Contract(rd.variableDebtTokenAddress, DEBT_TOKEN_ABI, p);
    const sdc = new Contract(rd.stableDebtTokenAddress, DEBT_TOKEN_ABI, p);

    const [ts, vr, sr] = await Promise.all([
      atc.totalSupply({ blockTag: bt }),
      vdc.totalSupply({ blockTag: bt }),
      sdc.totalSupply({ blockTag: bt }),
    ]);

    const tot = new BigNumber(ts.toString());
    const tb = new BigNumber(vr.toString()).plus(sr.toString());

    const util = tot.gt(0) ? tb.div(tot).toNumber() : 0;

    return {
      address: spTokenAddress,
      underlying,
      symbol,
      totalSupply: tot,
      totalBorrows: tb,
      utilization: util,
      idleRatio: 1 - util,
    };
  } catch {
    return null;
  }
}

export async function getAllSparkLendUtilizations(
  atTimestamp?: number,
): Promise<Map<string, UtilizationData>> {
  const res = new Map<string, UtilizationData>();
  const addrs = [
    '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    '0x779224df1c756b4edd899854f32a53e8c2b2ce5d',
    '0xc02ab1a5eaa8d1b114ef786d9bde108cd4364359',
    '0x4dedf26112b3ec8ec46e7e31ea5e123490b05b8b',
    '0x377c3bd93f2a2984e1e7be6a5c22c525ed4a4815',
  ];
  const u = await Promise.all(addrs.map((a) => getSparkLendUtilization(a, atTimestamp)));

  for (let i = 0; i < addrs.length; i++) {
    const d = u[i];
    if (d) res.set(addrs[i].toLowerCase(), d);
  }

  return res;
}

export async function getIdleRatio(spTokenAddress: string): Promise<number> {
  const d = await getSparkLendUtilization(spTokenAddress);
  return d?.idleRatio ?? 0;
}

export function isSparkLendAsset(address: string): boolean {
  const a = address.toLowerCase();
  return a === '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f' ||
    a === '0x779224df1c756b4edd899854f32a53e8c2b2ce5d' ||
    a === '0xc02ab1a5eaa8d1b114ef786d9bde108cd4364359' ||
    a === '0x4dedf26112b3ec8ec46e7e31ea5e123490b05b8b' ||
    a === '0x377c3bd93f2a2984e1e7be6a5c22c525ed4a4815';
}

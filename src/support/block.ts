// Resolve a UNIX timestamp to a block number via binary search.
//
// `eth_getBlockByNumber` is 20 CU on Alchemy, so O(log N) probes (~15–25
// calls) is far cheaper than a linear scan, especially on fast chains like
// Arbitrum (~0.25s/block) and Base/Optimism (~2s/block).

import { JsonRpcProvider } from 'ethers';
import type { Chain } from '../constants.ts';

export async function findBlockByTimestamp(
  provider: JsonRpcProvider,
  targetTs: number,
  chain?: Chain,
): Promise<number> {
  const lt = await provider.getBlockNumber();
  const lb = await provider.getBlock(lt);
  const lts = Number(lb?.timestamp ?? 0);
  if (!lts) return lt;

  if (targetTs >= lts) return lt;

  const sb = await provider.getBlock(Math.max(0, lt - 1000));
  const sts = Number(sb?.timestamp ?? lts);
  const defaultBlockTime = chain === 'arbitrum' ? 0.25 : chain === 'ethereum' ? 12 : chain ? 2 : 12;
  const bt = sb ? (lts - sts) / 1000 : defaultBlockTime;

  const eb = Math.floor((lts - targetTs) / bt);
  let lo = Math.max(0, lt - eb - 1000);
  let hi = Math.min(lt, lt - eb + 1000);

  const tl = await provider.getBlock(lo);
  if (tl && Number(tl.timestamp) > targetTs) {
    lo = Math.max(0, lo - 10000);
  }

  while (lo <= hi) {
    const m = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(m);
    const ts = Number(b?.timestamp ?? 0);
    if (!ts) return m;
    if (ts < targetTs) lo = m + 1;
    else hi = m - 1;
  }

  return Math.max(0, Math.min(lo, lt));
}

// Alchemy RPC provider factory.
//
// URL template:  https://{chain}-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}
// One API key works across every supported chain; the subdomain selects
// the network.
//
// Compute Units (CU): cheap reads (eth_blockNumber, eth_getBalance) ~10–20
// CU; eth_call 26 CU; eth_getBlockByNumber 20 CU; eth_getLogs 60 CU;
// trace/debug methods hundreds of CU. Rate limits are expressed in
// "throughput CU" — roughly a per-second ceiling.
//
// Archive access is on every endpoint by default: pass a numeric `blockTag`
// to any state read and Alchemy routes to archive nodes automatically.
//
// Deno: `Deno.env.get` requires --allow-env (or --allow-env=ALCHEMY_API_KEY).
// Network I/O requires --allow-net.

import { JsonRpcProvider, Network } from 'ethers';
import type { Chain } from '../constants.ts';

export function getProvider(
  chain: Chain,
  useFallback: boolean = false,
  alchemyKey?: string,
): JsonRpcProvider {
  if (useFallback) {
    if (chain === 'unichain') return new JsonRpcProvider('https://mainnet.unichain.org');
    if (chain === 'optimism') return new JsonRpcProvider('https://mainnet.optimism.io');
  }

  // Plume isn't hosted on Alchemy — use the public RPC.
  if (chain === 'plume') return new JsonRpcProvider('https://rpc.plume.org');

  const k = alchemyKey || Deno.env.get('ALCHEMY_API_KEY') || '';
  if (!k) throw new Error(`Missing Alchemy key for ${chain} in env`);

  const subdomain = {
    ethereum: 'eth-mainnet',
    base: 'base-mainnet',
    arbitrum: 'arb-mainnet',
    optimism: 'opt-mainnet',
    unichain: 'unichain-mainnet',
    avalanche: 'avax-mainnet',
    monad: 'monad-mainnet',
    plume: 'eth-mainnet', // unreachable, satisfies record completeness
  }[chain];

  const url = `https://${subdomain}.g.alchemy.com/v2/${k}`;

  const chainId = {
    ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10,
    unichain: 130, avalanche: 43114, monad: 10143, plume: 98866,
  }[chain];

  // Pin the network so ethers doesn't issue an eth_chainId probe.
  // `batchMaxCount: 1` keeps each Alchemy request separate — easier CU
  // accounting and per-call retries than coalesced JSON-RPC batches.
  const n = Network.from(chainId);
  return new JsonRpcProvider(url, n, { staticNetwork: n, batchMaxCount: 1 });
}

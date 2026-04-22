// Shared type definitions used across the library.

export type Chain =
  | 'ethereum'
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'unichain'
  | 'avalanche'
  | 'plume'
  | 'monad';

export interface IdleLendingPosition {
  address: string;
  symbol: string;
  underlyingSymbol: 'USDS' | 'DAI' | 'USDC' | 'USDT' | 'PYUSD' | 'AUSD' | 'RLUSD';
  protocol: string;
}

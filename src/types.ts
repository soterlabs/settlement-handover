// ---------------------------------------------------------------------------
// Shared type definitions for the debt-PnL calculation pipeline.
//
// Deno notes:
//   - `import type` statements are erased at compile time, so they do not
//     cost any runtime download. This is the same semantics as TypeScript in
//     Node, but it matters more in Deno because every import is a real
//     network-addressable URL that the runtime would otherwise fetch.
//   - All relative imports end with `.ts` (required by Deno's explicit module
//     resolution — see deno.json for the import map that powers bare
//     specifiers like 'kysely').
// ---------------------------------------------------------------------------

import type { Chain } from './constants.ts';
import type { Kysely } from 'kysely';
import type { SupabaseDB } from './db/schema.ts';

export interface DebtPnLRequest {
  star: string;
  startDate: Date;
  endDate: Date;
  chains?: Chain[];
}

export interface DebtPnLContext {
  db: Kysely<SupabaseDB>;
  starId: number;
  starName: string;
  periodStart: Date;
  periodEnd: Date;
  periodDays: number;
  chains: Chain[];
}

export interface CategoryBreakdown {
  network: Chain;
  address: string;
  symbol: string | null;
  averageBalanceUsd: number;
  startBalanceUsd?: number;
  endBalanceUsd?: number;
  reimbursementUsd?: number;
  idleRatio?: number;
  protocol?: string;
}

export interface DailyRow {
  date: string;
  network?: string;
  averageBalance: number;
  apr: number;
  dailyInterest: number;
  type?: string;
  source?: string;
  name?: string;
  revenue?: number;
  baseCost?: number;
  profit?: number;
  avgPrincipal?: number;
  baseRate?: number;
}

export interface DebtFeesResult {
  averageDebtUsd: number;
  averageBaseRatePercent: number;
  maxDebtFeesUsd: number;
  debtTimeline?: Array<{ timestamp: Date; debtUsd: number }>;
  dailyRows: DailyRow[];
}

export interface IdleStablecoinsResult {
  averageBalanceUsd: number;
  reimbursementUsd: number;
  breakdown: CategoryBreakdown[];
  dailyRows: DailyRow[];
  lendingDailyRows: DailyRow[];
  curveUsdsDailyRows: DailyRow[];
  curveSusdsDailyRows: DailyRow[];
  curveSdeDailyRows: DailyRow[];
}

export interface SusdsProfitResult {
  averageBalanceUsd: number;
  spreadBps: number;
  profitUsd: number;
  breakdown: CategoryBreakdown[];
  dailyRows: DailyRow[];
}

export interface SkyDirectExposureResult {
  averageBalanceUsd: number;
  reimbursementUsd: number;
  breakdown: CategoryBreakdown[];
  dailyRows: DailyRow[];
}

export interface Psm3IdleResult {
  averageBalanceUsd: number;
  reimbursementUsd: number;
  breakdown: CategoryBreakdown[];
  dailyRows: DailyRow[];
}

export interface Psm3SusdsProfitResult {
  averageBalanceUsd: number;
  spreadBps: number;
  profitUsd: number;
  breakdown: CategoryBreakdown[];
  dailyRows: DailyRow[];
}

export interface BorrowRateSubsidyResult {
  subsidyUsd: number;
  averageTBillRatePercent: number;
  averageSubsidizedRatePercent: number;
  dailyRows: DailyRow[];
}

export interface DebtPnLResponse {
  star: string;
  period: {
    start: string;
    end: string;
    days: number;
  };
  debt: DebtFeesResult;
  idleStablecoins: IdleStablecoinsResult;
  susdsProfit: SusdsProfitResult;
  skyDirectExposure: SkyDirectExposureResult;
  psm3IdleStablecoins: Psm3IdleResult;
  psm3SusdsProfit: Psm3SusdsProfitResult;
  borrowRateSubsidy: BorrowRateSubsidyResult;
  summary: {
    totalIdleReimbursementUsd: number;
    borrowRateSubsidyUsd: number;
    skyShareUsd: number;
  };
  sheets: {
    debt: DailyRow[];
    alm: DailyRow[];
    almSusds: DailyRow[];
    lendingIdle: DailyRow[];
    psm3: DailyRow[];
    psm3Susds: DailyRow[];
    skyDirectExposure: DailyRow[];
    curveSusds: DailyRow[];
    curveUsds: DailyRow[];
    curveSde: DailyRow[];
    borrowRateSubsidy: DailyRow[];
  };
}

export interface AssetSnapshot {
  address: string;
  chain: Chain;
  symbol: string | null;
  timestamp: Date;
  balanceUsd: number;
}

export interface AggregatedBalance {
  chain: Chain;
  address: string;
  symbol: string | null;
  snapshots: Array<{ timestamp: Date; balanceUsd: number }>;
  averageBalanceUsd: number;
  startBalanceUsd: number;
  endBalanceUsd: number;
}

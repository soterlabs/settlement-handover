// Top-level orchestration: fans out to every calculation module and stitches
// the results into the DebtPnLResponse shape consumed by the HTTP route.

import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import type { SupabaseDB } from './db/schema.ts';
import type {
  DebtPnLRequest,
  DebtPnLContext,
  DebtPnLResponse,
  IdleStablecoinsResult,
  SusdsProfitResult,
  SkyDirectExposureResult,
  Psm3IdleResult,
  Psm3SusdsProfitResult,
  BorrowRateSubsidyResult,
} from './types.ts';
import type { Chain } from './constants.ts';
import { calculateDebtFees } from './calculations/debt-fees.ts';
import { calculateIdleStablecoins } from './calculations/idle-stablecoins.ts';
import { calculateSusdsProfit } from './calculations/susds-profit.ts';
import { calculateSkyDirectExposure } from './calculations/sky-direct-exposure.ts';
import { calculatePsm3Idle } from './calculations/psm3-idle.ts';
import { calculatePsm3SusdsProfit } from './calculations/psm3-susds.ts';
import { calculateBorrowRateSubsidy } from './calculations/borrow-rate-subsidy.ts';

export async function calculateDebtPnL(
  db: Kysely<SupabaseDB>,
  request: DebtPnLRequest,
): Promise<DebtPnLResponse> {
  const sid = await resolveStarId(db, request.star);
  if (!sid) throw new Error(`Star not found: ${request.star}`);

  const ps = request.startDate;
  const pe = request.endDate;
  const sd = DateTime.fromJSDate(ps, { zone: 'utc' });
  const ed = DateTime.fromJSDate(pe, { zone: 'utc' });
  const pd = ed.day === ed.daysInMonth && sd.day === 1 && sd.month === ed.month
    ? ed.daysInMonth
    : Math.round(ed.diff(sd, 'days').days);

  const starChains: Record<string, Chain[]> = {
    spark: ['ethereum', 'base', 'arbitrum', 'optimism', 'unichain', 'avalanche'],
    grove: ['ethereum', 'base', 'avalanche', 'plume', 'monad'],
    obex: ['ethereum'],
  };

  const ctx: DebtPnLContext = {
    db,
    starId: sid,
    starName: request.star,
    periodStart: ps,
    periodEnd: pe,
    periodDays: pd,
    chains: request.chains ?? (starChains[request.star.toLowerCase()] || starChains.spark),
  };

  // Debt fees run first — the base-rate output feeds every idle/PSM3 module.
  const dr = await calculateDebtFees(ctx);

  // Remaining reimbursement modules are independent — fan out concurrently.
  let iRes: IdleStablecoinsResult;
  let sRes: SusdsProfitResult;
  let skyRes: SkyDirectExposureResult;
  let p3iRes: Psm3IdleResult;
  let p3sRes: Psm3SusdsProfitResult;

  [iRes, sRes, skyRes, p3iRes, p3sRes] = await Promise.all([
    calculateIdleStablecoins(ctx, dr.averageBaseRatePercent),
    calculateSusdsProfit(ctx),
    calculateSkyDirectExposure(ctx, dr.averageBaseRatePercent),
    calculatePsm3Idle(ctx, dr.averageBaseRatePercent),
    calculatePsm3SusdsProfit(ctx),
  ]);

  const elig = ['spark', 'grove'].includes(ctx.starName.toLowerCase());

  let bs: BorrowRateSubsidyResult;
  if (elig) {
    try {
      bs = await calculateBorrowRateSubsidy(ctx, dr);
    } catch (err) {
      console.warn('Borrow rate subsidy calculation failed, defaulting to 0:', err);
      bs = { subsidyUsd: 0, averageTBillRatePercent: 0, averageSubsidizedRatePercent: 0, dailyRows: [] };
    }
  } else {
    bs = { subsidyUsd: 0, averageTBillRatePercent: 0, averageSubsidizedRatePercent: 0, dailyRows: [] };
  }

  const tir = iRes.reimbursementUsd +
    sRes.profitUsd +
    skyRes.reimbursementUsd +
    p3iRes.reimbursementUsd +
    p3sRes.profitUsd;

  const sub = bs.subsidyUsd;

  return {
    star: request.star,
    period: { start: ps.toISOString(), end: pe.toISOString(), days: pd },
    debt: {
      averageDebtUsd: dr.averageDebtUsd,
      averageBaseRatePercent: dr.averageBaseRatePercent,
      maxDebtFeesUsd: dr.maxDebtFeesUsd,
      dailyRows: dr.dailyRows,
    },
    idleStablecoins: iRes,
    susdsProfit: sRes,
    skyDirectExposure: skyRes,
    psm3IdleStablecoins: p3iRes,
    psm3SusdsProfit: p3sRes,
    borrowRateSubsidy: bs,
    summary: {
      totalIdleReimbursementUsd: tir,
      borrowRateSubsidyUsd: sub,
      skyShareUsd: dr.maxDebtFeesUsd - tir - sub,
    },
    sheets: {
      debt: dr.dailyRows,
      alm: iRes.dailyRows,
      almSusds: sRes.dailyRows,
      lendingIdle: iRes.lendingDailyRows,
      psm3: p3iRes.dailyRows,
      psm3Susds: p3sRes.dailyRows,
      skyDirectExposure: skyRes.dailyRows,
      borrowRateSubsidy: bs.dailyRows,
      curveSusds: iRes.curveSusdsDailyRows,
      curveUsds: iRes.curveUsdsDailyRows,
      curveSde: iRes.curveSdeDailyRows,
    },
  };
}

async function resolveStarId(
  db: Kysely<SupabaseDB>,
  starName: string,
): Promise<number | null> {
  const r = await db
    .selectFrom('stars')
    .select('id')
    .where('name', '=', starName.toLowerCase())
    .executeTakeFirst();
  return r?.id ?? null;
}

export function parsePeriodParams(params: {
  start?: string;
  end?: string;
  month?: string;
}): { startDate: Date; endDate: Date } {
  if (params.start && params.end) {
    return { startDate: new Date(params.start), endDate: new Date(params.end) };
  }

  if (params.month) {
    const [y, m] = params.month.split('-').map(Number);
    return {
      startDate: DateTime.utc(y, m, 1).toJSDate(),
      endDate: DateTime.utc(y, m, 1).plus({ months: 1 }).startOf('day').toJSDate(),
    };
  }

  const now = DateTime.utc();
  return { startDate: now.startOf('month').toJSDate(), endDate: now.toJSDate() };
}

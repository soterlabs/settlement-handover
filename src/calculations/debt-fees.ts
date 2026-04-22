// Debt fees — purely off-chain arithmetic (DB + memory). The
// averageBaseRatePercent it produces is fed into every idle/PSM3 module,
// where it's multiplied against asset balances that *were* sampled
// on-chain via Alchemy.

import BigNumber from "bignumber.js";
import { DateTime } from "luxon";
import type { DebtPnLContext, DebtFeesResult, DailyRow } from "../types.ts";
import { getSSRSegments } from "../support/ssr-calculator.ts";
import {
  generateDayRanges,
  calculateDailyTimeWeightedAverageDebt,
  type DebtSnapshot,
} from "./daily-calculations.ts";

interface RawDebtSnapshot {
  datetime: Date;
  debt: string | number | null;
}

interface RateSegment {
  startTime: Date;
  ratePerSecond: BigNumber;
}

function apyToPerSecondRate(a: number): BigNumber {
  return new BigNumber(Math.pow(1 + a, 1 / 31536000) - 1);
}

function perSecondRateToApy(r: BigNumber): number {
  return Math.pow(1 + r.toNumber(), 31536000) - 1;
}

function toDate(v: Date | string | number): Date {
  if (v instanceof Date) return v;
  return new Date(v);
}

export async function calculateDebtFees(ctx: DebtPnLContext): Promise<DebtFeesResult> {
  const [raw, ssr] = await Promise.all([
    fetchDebtTimeline(ctx),
    getSSRSegments(ctx.db, ctx.periodStart, ctx.periodEnd),
  ]);

  const snaps: DebtSnapshot[] = raw.map((s) => ({
    timestamp: toDate(s.datetime),
    debtUsd: parseFloat(String(s.debt ?? 0)),
  }));

  const sp = apyToPerSecondRate(30 / 10000);

  const segs: RateSegment[] = ssr.map((s) => {
    // rawSsr is stored as (1 + per-second rate) × 1e27 (Aave RAY encoding).
    const ps = s.rawSsr
      ? new BigNumber(s.rawSsr).dividedBy("1e27").minus(1)
      : apyToPerSecondRate(s.ratePercent / 100);

    return { startTime: toDate(s.startTime), ratePerSecond: ps.plus(sp) };
  });

  const days = generateDayRanges(ctx.periodStart, ctx.periodEnd);

  let ti = new BigNumber(0);
  let twd = new BigNumber(0);
  let twr = new BigNumber(0);
  let td = 0;
  const rows: DailyRow[] = [];

  for (const d of days) {
    const v = calculateDailyTimeWeightedAverageDebt(snaps, d.dayStart, d.dayEnd);
    const r = calculateDailyTimeWeightedAverageRate(segs, d.dayStart, d.dayEnd);
    const apr = perSecondRateToApy(r);

    if (v > 0) {
      const di = new BigNumber(v).multipliedBy(r).multipliedBy(86400);

      ti = ti.plus(di);
      twd = twd.plus(v);
      twr = twr.plus(perSecondRateToApy(r) * 100);
      td++;

      rows.push({
        date: DateTime.fromJSDate(d.dayStart, { zone: "utc" }).toFormat("yyyy-MM-dd"),
        averageBalance: v,
        apr: apr,
        dailyInterest: di.toNumber(),
      });
    }
  }

  return {
    averageDebtUsd: td > 0 ? twd.dividedBy(td).toNumber() : 0,
    averageBaseRatePercent: td > 0 ? twr.dividedBy(td).toNumber() : 0,
    maxDebtFeesUsd: ti.toNumber(),
    debtTimeline: snaps.map((s) => ({ timestamp: s.timestamp, debtUsd: s.debtUsd })),
    dailyRows: rows,
  };
}

function calculateDailyTimeWeightedAverageRate(
  segs: RateSegment[],
  dayStart: Date,
  dayEnd: Date,
): BigNumber {
  if (segs.length === 0) return apyToPerSecondRate(0.045);

  const s = [...segs].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const t0 = dayStart.getTime();
  const t1 = dayEnd.getTime();
  const td = t1 - t0;

  if (td <= 0) return s[0]?.ratePerSecond ?? apyToPerSecondRate(0.045);

  const pre = s.filter((x) => x.startTime.getTime() <= t0).pop();
  const wd = s.filter((x) => x.startTime.getTime() > t0 && x.startTime.getTime() <= t1);

  const eff: RateSegment[] = [];

  if (pre) {
    eff.push({ startTime: dayStart, ratePerSecond: pre.ratePerSecond });
  } else if (s.length > 0) {
    eff.push({ startTime: dayStart, ratePerSecond: s[0].ratePerSecond });
  }

  eff.push(...wd);

  if (eff.length === 0) return apyToPerSecondRate(0.045);

  let ws = new BigNumber(0);

  for (let i = 0; i < eff.length; i++) {
    const c = eff[i];
    const n = eff[i + 1];

    const a = Math.max(c.startTime.getTime(), t0);
    const b = n ? Math.min(n.startTime.getTime(), t1) : t1;

    if (b <= a) continue;

    ws = ws.plus(c.ratePerSecond.multipliedBy(b - a));
  }

  return ws.dividedBy(td);
}

async function fetchDebtTimeline(ctx: DebtPnLContext): Promise<RawDebtSnapshot[]> {
  const sq = ctx.db
    .selectFrom("star_allocation_systems as sas")
    .innerJoin("networks as n", "n.id", "sas.network_id")
    .select(["sas.datetime", "sas.debt"])
    .where("sas.star_id", "=", ctx.starId)
    .where("n.name", "=", "ethereum")
    .where("sas.datetime", "<", ctx.periodStart)
    .where("sas.debt", "is not", null)
    .orderBy("sas.datetime", "desc")
    .limit(1);

  const pq = ctx.db
    .selectFrom("star_allocation_systems as sas")
    .innerJoin("networks as n", "n.id", "sas.network_id")
    .select(["sas.datetime", "sas.debt"])
    .where("sas.star_id", "=", ctx.starId)
    .where("n.name", "=", "ethereum")
    .where("sas.datetime", ">=", ctx.periodStart)
    .where("sas.datetime", "<=", ctx.periodEnd)
    .where("sas.debt", "is not", null)
    .orderBy("sas.datetime", "asc");

  const [sr, pr] = await Promise.all([sq.execute(), pq.execute()]);

  const tl: RawDebtSnapshot[] = [];

  if (sr.length > 0) {
    tl.push({ datetime: ctx.periodStart, debt: sr[0].debt });
  }

  for (const row of pr) {
    tl.push({ datetime: new Date(row.datetime), debt: row.debt });
  }

  return tl;
}

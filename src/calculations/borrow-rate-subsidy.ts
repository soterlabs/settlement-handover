import BigNumber from "bignumber.js";
import { DateTime } from "luxon";
import type {
  DebtPnLContext,
  DebtFeesResult,
  BorrowRateSubsidyResult,
  DailyRow,
} from "../types.ts";

const yc = new Map<number, Map<string, number>>();

async function fetchYieldCurveForYear(y: number): Promise<Map<string, number>> {
  if (yc.has(y)) return yc.get(y)!;

  const res = await fetch(
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml` +
      `?data=daily_treasury_yield_curve&field_tdr_date_value=${y}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch yield curve for ${y}: ${res.status}`);

  const xml = await res.text();
  const m = new Map<string, number>();

  const re = /<m:properties>[\s\S]*?<\/m:properties>/g;
  let mt;
  while ((mt = re.exec(xml)) !== null) {
    const p = mt[0];
    const dm = p.match(/<d:NEW_DATE[^>]*>(\d{4}-\d{2}-\d{2})T/);
    const rm = p.match(/<d:BC_3MONTH[^>]*>([\d.]+)<\/d:BC_3MONTH>/);
    if (dm && rm) m.set(dm[1], parseFloat(rm[1]));
  }

  yc.set(y, m);
  return m;
}

export async function getDailyTBillRate(dateStr: string): Promise<number> {
  const dt = DateTime.fromISO(dateStr, { zone: "utc" });
  const rates = await fetchYieldCurveForYear(dt.year);

  for (let i = 0; i <= 10; i++) {
    const c = dt.minus({ days: i });
    const k = c.toFormat("yyyy-MM-dd");
    const r = c.year !== dt.year ? await fetchYieldCurveForYear(c.year) : rates;
    if (r.has(k)) return r.get(k)!;
  }

  throw new Error(`No BC_3MONTH rate found for ${dateStr} or within 10 days prior`);
}

export async function calculateBorrowRateSubsidy(
  _ctx: DebtPnLContext,
  debtResult: DebtFeesResult,
): Promise<BorrowRateSubsidyResult> {
  const ss = DateTime.fromISO("2026-01-01", { zone: "utc" });

  let ts = new BigNumber(0);
  let twt = new BigNumber(0);
  let twsr = new BigNumber(0);
  let dc = 0;
  const rows: DailyRow[] = [];

  for (const r of debtResult.dailyRows) {
    const rd = DateTime.fromISO(r.date, { zone: "utc" });
    const T = (rd.year - ss.year) * 12 + (rd.month - ss.month) + 1;

    if (T < 1 || T > 24) continue;

    const tp = await getDailyTBillRate(r.date);
    const tbd = tp / 100;
    const br = r.apr;

    let sr = tbd + (br - tbd) * (T / 24);

    if (sr > br) sr = br;
    if (sr < 0) sr = 0;

    const ed = Math.min(r.averageBalance, 1_000_000_000);

    const bps = new BigNumber(Math.pow(1 + br, 1 / 31536000) - 1);
    const sps = new BigNumber(Math.pow(1 + sr, 1 / 31536000) - 1);

    const ds = new BigNumber(ed).multipliedBy(bps.minus(sps)).multipliedBy(86400);
    const cs = ds.isGreaterThan(0) ? ds : new BigNumber(0);

    ts = ts.plus(cs);
    twt = twt.plus(tp);
    twsr = twsr.plus(sr * 100);
    dc++;

    rows.push({
      date: r.date,
      averageBalance: ed,
      apr: sr,
      baseRate: br,
      dailyInterest: cs.toNumber(),
    });
  }

  return {
    subsidyUsd: ts.toNumber(),
    averageTBillRatePercent: dc > 0 ? twt.dividedBy(dc).toNumber() : 0,
    averageSubsidizedRatePercent: dc > 0 ? twsr.dividedBy(dc).toNumber() : 0,
    dailyRows: rows,
  };
}

// The only external dependency is `luxon` for
// timezone-correct day boundaries. Deno pulls `luxon` from npm: via the
// import map in deno.json — the `npm:` scheme makes npm packages
// first-class citizens without a node_modules directory.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";

export interface DayRange {
  dayStart: Date;
  dayEnd: Date;
  dayIndex: number;
}

export function generateDayRanges(periodStart: Date, periodEnd: Date): DayRange[] {
  const r: DayRange[] = [];
  const a = DateTime.fromJSDate(periodStart, { zone: "utc" }).startOf("day");
  const b = DateTime.fromJSDate(periodEnd, { zone: "utc" }).endOf("day");

  let c = a;
  let i = 0;

  while (c < b) {
    const s = c.toJSDate();
    const e = c.endOf("day").toJSDate();
    r.push({
      dayStart: s,
      dayEnd: e > periodEnd ? periodEnd : e,
      dayIndex: i,
    });
    c = c.plus({ days: 1 });
    i++;
  }

  return r;
}

export interface BalanceSnapshot {
  timestamp: Date;
  balanceUsd: number;
}

export function calculateDailyTimeWeightedAverage(
  snapshots: BalanceSnapshot[],
  dayStart: Date,
  dayEnd: Date,
): number {
  if (snapshots.length === 0) return 0;

  const s = [...snapshots].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const t0 = dayStart.getTime();
  const t1 = dayEnd.getTime();
  const td = t1 - t0;

  if (td <= 0) return 0;

  const rel = s.filter((x) => x.timestamp.getTime() <= t1);
  if (rel.length === 0) return 0;

  const pre = rel.filter((x) => x.timestamp.getTime() <= t0).pop();
  const wd = rel.filter((x) => x.timestamp.getTime() > t0 && x.timestamp.getTime() <= t1);

  const eff: BalanceSnapshot[] = [];
  if (pre) eff.push({ timestamp: dayStart, balanceUsd: pre.balanceUsd });
  eff.push(...wd);
  if (eff.length === 0) return 0;

  let ws = 0;

  for (let i = 0; i < eff.length; i++) {
    const c = eff[i];
    const n = eff[i + 1];
    const a = Math.max(c.timestamp.getTime(), t0);
    const b = n ? Math.min(n.timestamp.getTime(), t1) : t1;
    if (b <= a) continue;
    ws += c.balanceUsd * (b - a);
  }

  return ws / td;
}

export interface DebtSnapshot {
  timestamp: Date;
  debtUsd: number;
}

export function calculateDailyTimeWeightedAverageDebt(
  snapshots: DebtSnapshot[],
  dayStart: Date,
  dayEnd: Date,
): number {
  if (snapshots.length === 0) return 0;

  const s = [...snapshots].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const t0 = dayStart.getTime();
  const t1 = dayEnd.getTime();
  const td = t1 - t0;

  if (td <= 0) return 0;

  const rel = s.filter((x) => x.timestamp.getTime() <= t1);
  if (rel.length === 0) return 0;

  const pre = rel.filter((x) => x.timestamp.getTime() <= t0).pop();
  const wd = rel.filter((x) => x.timestamp.getTime() > t0 && x.timestamp.getTime() <= t1);

  const eff: DebtSnapshot[] = [];
  if (pre) eff.push({ timestamp: dayStart, debtUsd: pre.debtUsd });
  eff.push(...wd);
  if (eff.length === 0) return 0;

  let ws = 0;

  for (let i = 0; i < eff.length; i++) {
    const c = eff[i];
    const n = eff[i + 1];
    const a = Math.max(c.timestamp.getTime(), t0);
    const b = n ? Math.min(n.timestamp.getTime(), t1) : t1;
    if (b <= a) continue;
    ws += c.debtUsd * (b - a);
  }

  return ws / td;
}

import BigNumber from "bignumber.js";
import { DateTime } from "luxon";
import type {
  DebtPnLContext,
  Psm3IdleResult,
  CategoryBreakdown,
  AggregatedBalance,
  DailyRow,
} from "../types.ts";
import type { Chain } from "../constants.ts";
import {
  generateDayRanges,
  calculateDailyTimeWeightedAverage,
  type BalanceSnapshot,
} from "./daily-calculations.ts";

export async function calculatePsm3Idle(
  ctx: DebtPnLContext,
  baseRatePercent: number,
): Promise<Psm3IdleResult> {
  const addrs: Array<{ chain: Chain; address: string }> = [];
  if (ctx.chains.includes("ethereum"))
    addrs.push({ chain: "ethereum", address: "0xdc035d45d973e3ec169d2276ddab16f1e407384f" });
  if (ctx.chains.includes("base"))
    addrs.push({ chain: "base", address: "0x820c137fa70c8691f0e44dc420a5e53c168921dc" });
  if (ctx.chains.includes("arbitrum"))
    addrs.push({ chain: "arbitrum", address: "0x6491c05a82219b8d1479057361ff1654749b876b" });
  if (ctx.chains.includes("optimism"))
    addrs.push({ chain: "optimism", address: "0x4f13a96ec5c4cf34e442b46bbd98a0791f20edc3" });
  if (ctx.chains.includes("unichain"))
    addrs.push({ chain: "unichain", address: "0x7e10036acc4b56d4dfca3b77810356ce52313f9c" });

  if (addrs.length === 0) {
    return { averageBalanceUsd: 0, reimbursementUsd: 0, breakdown: [], dailyRows: [] };
  }

  const bals = await fetchPsm3Balances(ctx, addrs);

  const days = generateDayRanges(ctx.periodStart, ctx.periodEnd);
  const bps = new BigNumber(Math.pow(1 + baseRatePercent / 100, 1 / 31536000) - 1);
  const br = baseRatePercent / 100;

  let tr = new BigNumber(0);
  let tab = new BigNumber(0);
  const bd: CategoryBreakdown[] = [];
  const rows: DailyRow[] = [];

  for (const a of bals) {
    const snaps: BalanceSnapshot[] = a.snapshots.map((s) => ({
      timestamp: s.timestamp,
      balanceUsd: s.balanceUsd,
    }));

    let ar = new BigNumber(0);
    let atb = new BigNumber(0);
    let dw = 0;

    for (const d of days) {
      const v = calculateDailyTimeWeightedAverage(snaps, d.dayStart, d.dayEnd);

      if (v > 0) {
        const dr = new BigNumber(v).multipliedBy(bps).multipliedBy(86400);

        ar = ar.plus(dr);
        atb = atb.plus(v);
        dw++;
        rows.push({
          date: DateTime.fromJSDate(d.dayStart, { zone: "utc" }).toFormat("yyyy-MM-dd"),
          network: a.chain,
          averageBalance: v,
          apr: br,
          dailyInterest: dr.toNumber(),
        });
      }
    }

    const avg = dw > 0 ? atb.dividedBy(dw).toNumber() : 0;

    tr = tr.plus(ar);
    tab = tab.plus(avg);

    bd.push({
      network: a.chain,
      address: a.address,
      symbol: a.symbol,
      averageBalanceUsd: avg,
      startBalanceUsd: a.startBalanceUsd,
      endBalanceUsd: a.endBalanceUsd,
    });
  }

  return {
    averageBalanceUsd: tab.toNumber(),
    reimbursementUsd: tr.toNumber(),
    breakdown: bd,
    dailyRows: rows,
  };
}

async function fetchPsm3Balances(
  ctx: DebtPnLContext,
  targetAddresses: Array<{ chain: Chain; address: string }>,
): Promise<AggregatedBalance[]> {
  const al = targetAddresses.map((t) => t.address.toLowerCase());

  const sq = ctx.db
    .selectFrom("star_allocation_system_assets as a")
    .innerJoin("star_allocation_systems as sys", "sys.id", "a.star_allocation_system_id")
    .innerJoin("tokens as t", "t.id", "a.token_id")
    .innerJoin("addresses as addr", "addr.id", "t.address_id")
    .innerJoin("networks as n", "n.id", "addr.network_id")
    .select([
      "n.name as chain",
      "addr.public_key as address",
      "t.symbol as symbol",
      "a.total_usd as totalUsd",
      "sys.datetime as timestamp",
    ])
    .where("sys.star_id", "=", ctx.starId)
    .where("sys.datetime", "<", ctx.periodStart)
    .where("a.source", "=", "psm3")
    .where((eb) => eb.fn("lower", ["addr.public_key"]), "in", al)
    .orderBy("sys.datetime", "desc");

  const pq = ctx.db
    .selectFrom("star_allocation_system_assets as a")
    .innerJoin("star_allocation_systems as sys", "sys.id", "a.star_allocation_system_id")
    .innerJoin("tokens as t", "t.id", "a.token_id")
    .innerJoin("addresses as addr", "addr.id", "t.address_id")
    .innerJoin("networks as n", "n.id", "addr.network_id")
    .select([
      "n.name as chain",
      "addr.public_key as address",
      "t.symbol as symbol",
      "a.total_usd as totalUsd",
      "sys.datetime as timestamp",
    ])
    .where("sys.star_id", "=", ctx.starId)
    .where("sys.datetime", ">=", ctx.periodStart)
    .where("sys.datetime", "<=", ctx.periodEnd)
    .where("a.source", "=", "psm3")
    .where((eb) => eb.fn("lower", ["addr.public_key"]), "in", al)
    .orderBy("sys.datetime", "asc");

  const [sr, pr] = await Promise.all([sq.execute(), pq.execute()]);

  const am = new Map<string, AggregatedBalance>();

  for (const a of targetAddresses) {
    am.set(`${a.chain}:${a.address}`, {
      chain: a.chain,
      address: a.address,
      symbol: null,
      snapshots: [],
      averageBalanceUsd: 0,
      startBalanceUsd: 0,
      endBalanceUsd: 0,
    });
  }

  const sb = new Map<string, (typeof sr)[0]>();
  for (const r of sr) {
    if (!r.address) continue;
    const k = `${r.chain}:${r.address.toLowerCase()}`;
    if (!sb.has(k)) sb.set(k, r);
  }

  for (const [k, a] of am) {
    const s = sb.get(k);
    if (s) {
      a.symbol = s.symbol;
      a.snapshots.push({
        timestamp: ctx.periodStart,
        balanceUsd: parseFloat(String(s.totalUsd) || "0"),
      });
    }
  }

  for (const r of pr) {
    if (!r.address) continue;
    const a = am.get(`${r.chain}:${r.address.toLowerCase()}`);
    if (a) {
      a.symbol = r.symbol;
      a.snapshots.push({
        timestamp: new Date(r.timestamp),
        balanceUsd: parseFloat(String(r.totalUsd) || "0"),
      });
    }
  }

  for (const a of am.values()) {
    if (a.snapshots.length > 0) {
      a.startBalanceUsd = a.snapshots[0].balanceUsd;
      a.endBalanceUsd = a.snapshots[a.snapshots.length - 1].balanceUsd;
    }
  }

  return Array.from(am.values()).filter((a) => a.snapshots.length > 0);
}

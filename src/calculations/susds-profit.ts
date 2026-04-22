import BigNumber from "bignumber.js";
import { DateTime } from "luxon";
import type {
  DebtPnLContext,
  SusdsProfitResult,
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

export function isSusds(address: string, chain: Chain): boolean {
  const a = address.toLowerCase();
  if (chain === "ethereum") return a === "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
  if (chain === "base") return a === "0x5875eee11cf8398102fdad704c9e96607675467a";
  if (chain === "arbitrum") return a === "0xddb46999f8891663a8f2828d25298f70416d7610";
  if (chain === "optimism") return a === "0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0";
  if (chain === "unichain") return a === "0xa06b10db9f390990364a3984c04fadf1c13691b5";
  return false;
}

export async function calculateSusdsProfit(ctx: DebtPnLContext): Promise<SusdsProfitResult> {
  // ethereum sUSDS is excluded on purpose — the Ethereum balance is the
  // source of the spread, not a reimbursement destination.
  const addrs: Array<{ chain: Chain; address: string }> = [];
  if (ctx.chains.includes("base"))
    addrs.push({ chain: "base", address: "0x5875eee11cf8398102fdad704c9e96607675467a" });
  if (ctx.chains.includes("arbitrum"))
    addrs.push({ chain: "arbitrum", address: "0xddb46999f8891663a8f2828d25298f70416d7610" });
  if (ctx.chains.includes("optimism"))
    addrs.push({ chain: "optimism", address: "0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0" });
  if (ctx.chains.includes("unichain"))
    addrs.push({ chain: "unichain", address: "0xa06b10db9f390990364a3984c04fadf1c13691b5" });

  if (addrs.length === 0) {
    return { averageBalanceUsd: 0, spreadBps: 30, profitUsd: 0, breakdown: [], dailyRows: [] };
  }

  const bals = await fetchSusdsBalances(ctx, addrs);

  const days = generateDayRanges(ctx.periodStart, ctx.periodEnd);
  const sps = new BigNumber(Math.pow(1 + 30 / 10000, 1 / 31536000) - 1);

  let tp = new BigNumber(0);
  let tab = new BigNumber(0);
  const bd: CategoryBreakdown[] = [];
  const rows: DailyRow[] = [];

  for (const a of bals) {
    const snaps: BalanceSnapshot[] = a.snapshots.map((s) => ({
      timestamp: s.timestamp,
      balanceUsd: s.balanceUsd,
    }));

    let ap = new BigNumber(0);
    let atb = new BigNumber(0);
    let dw = 0;

    for (const d of days) {
      const v = calculateDailyTimeWeightedAverage(snaps, d.dayStart, d.dayEnd);

      if (v > 0) {
        const dp = new BigNumber(v).multipliedBy(sps).multipliedBy(86400);

        ap = ap.plus(dp);
        atb = atb.plus(v);
        dw++;
        rows.push({
          date: DateTime.fromJSDate(d.dayStart, { zone: "utc" }).toFormat("yyyy-MM-dd"),
          network: a.chain,
          averageBalance: v,
          apr: 30 / 10000,
          dailyInterest: dp.toNumber(),
        });
      }
    }

    const avg = dw > 0 ? atb.dividedBy(dw).toNumber() : 0;

    tp = tp.plus(ap);
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
    spreadBps: 30,
    profitUsd: tp.toNumber(),
    breakdown: bd,
    dailyRows: rows,
  };
}

async function fetchSusdsBalances(
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
    .where("a.source", "=", "alm")
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
    .where("a.source", "=", "alm")
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

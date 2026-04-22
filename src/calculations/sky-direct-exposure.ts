import BigNumber from "bignumber.js";
import { DateTime } from "luxon";
import type {
  DebtPnLContext,
  SkyDirectExposureResult,
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

export function isSkyDirectExposure(address: string, chain: Chain): boolean {
  const a = address.toLowerCase();
  return (
    (chain === "base" && a === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") ||
    (chain === "arbitrum" && a === "0xaf88d065e77c8cc2239327c5edb3a432268e5831") ||
    (chain === "optimism" && a === "0x0b2c639c533813f4aa9d7837caf62653d097ff85") ||
    (chain === "unichain" && a === "0x078d782b760474a361dda0af3839290b0ef57ad6") ||
    (chain === "ethereum" && a === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
  );
}

export async function calculateSkyDirectExposure(
  ctx: DebtPnLContext,
  baseRatePercent: number,
): Promise<SkyDirectExposureResult> {
  if (
    DateTime.fromJSDate(ctx.periodStart, { zone: "utc" }) <
    DateTime.fromISO("2025-11-01", { zone: "utc" })
  ) {
    return { averageBalanceUsd: 0, reimbursementUsd: 0, breakdown: [], dailyRows: [] };
  }

  // `psm3` = addresses read from the PSM3 indexer source; `alm` = Ethereum
  // USDC from the ALMProxy source (no `requiredSource` in the old config).
  const psm3Addrs: Array<{ chain: Chain; address: string }> = [];
  if (ctx.chains.includes("base"))
    psm3Addrs.push({ chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
  if (ctx.chains.includes("arbitrum"))
    psm3Addrs.push({ chain: "arbitrum", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" });
  if (ctx.chains.includes("optimism"))
    psm3Addrs.push({ chain: "optimism", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" });
  if (ctx.chains.includes("unichain"))
    psm3Addrs.push({ chain: "unichain", address: "0x078d782b760474a361dda0af3839290b0ef57ad6" });

  const anySourceAddrs: Array<{ chain: Chain; address: string }> = [];
  if (ctx.chains.includes("ethereum"))
    anySourceAddrs.push({
      chain: "ethereum",
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    });

  const ta = [...psm3Addrs, ...anySourceAddrs];

  if (ta.length === 0) {
    return { averageBalanceUsd: 0, reimbursementUsd: 0, breakdown: [], dailyRows: [] };
  }

  const ab = await fetchAssetBalances(ctx, psm3Addrs, anySourceAddrs);

  const dr = generateDayRanges(ctx.periodStart, ctx.periodEnd);
  const brps = new BigNumber(Math.pow(1 + baseRatePercent / 100, 1 / 31536000) - 1);
  const bra = baseRatePercent / 100;

  let tr = new BigNumber(0);
  let tab = new BigNumber(0);
  const breakdown: CategoryBreakdown[] = [];
  const dailyRows: DailyRow[] = [];

  for (const asset of ab) {
    const snaps: BalanceSnapshot[] = asset.snapshots.map((s) => ({
      timestamp: s.timestamp,
      balanceUsd: s.balanceUsd,
    }));

    let ar = new BigNumber(0);
    let atb = new BigNumber(0);
    let db = 0;

    for (let i = 0; i < dr.length; i++) {
      const day = dr[i];
      const v = calculateDailyTimeWeightedAverage(snaps, day.dayStart, day.dayEnd);

      if (v > 0) {
        const di = new BigNumber(v).multipliedBy(brps).multipliedBy(86400);

        ar = ar.plus(di);
        atb = atb.plus(v);
        db++;

        dailyRows.push({
          date: DateTime.fromJSDate(day.dayStart, { zone: "utc" }).toFormat("yyyy-MM-dd"),
          network: asset.chain,
          averageBalance: v,
          apr: bra,
          dailyInterest: di.toNumber(),
          source: "psm3",
        });
      }
    }

    const avg = db > 0 ? atb.dividedBy(db).toNumber() : 0;

    tr = tr.plus(ar);
    tab = tab.plus(avg);

    breakdown.push({
      network: asset.chain,
      address: asset.address,
      symbol: "USDC",
      averageBalanceUsd: avg,
      startBalanceUsd: asset.startBalanceUsd,
      endBalanceUsd: asset.endBalanceUsd,
    });
  }

  return {
    averageBalanceUsd: tab.toNumber(),
    reimbursementUsd: tr.toNumber(),
    breakdown,
    dailyRows,
  };
}

async function fetchAssetBalances(
  ctx: DebtPnLContext,
  psm3Addrs: Array<{ chain: Chain; address: string }>,
  anySourceAddrs: Array<{ chain: Chain; address: string }>,
): Promise<AggregatedBalance[]> {
  const psm3Lower = psm3Addrs.map((t) => t.address.toLowerCase());
  const anyLower = anySourceAddrs.map((t) => t.address.toLowerCase());

  const rows: Array<{
    chain: string;
    address: string | null;
    symbol: string;
    totalUsd: string | number;
    timestamp: Date;
    seed: boolean;
  }> = [];

  if (psm3Lower.length > 0) {
    const seed = await ctx.db
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
      .where((eb) => eb.fn("lower", ["addr.public_key"]), "in", psm3Lower)
      .orderBy("sys.datetime", "desc")
      .execute();

    const period = await ctx.db
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
      .where((eb) => eb.fn("lower", ["addr.public_key"]), "in", psm3Lower)
      .orderBy("sys.datetime", "asc")
      .execute();

    for (const r of seed) rows.push({ ...r, timestamp: new Date(r.timestamp), seed: true });
    for (const r of period) rows.push({ ...r, timestamp: new Date(r.timestamp), seed: false });
  }

  if (anyLower.length > 0) {
    const seed = await ctx.db
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
      .where((eb) => eb.fn("lower", ["addr.public_key"]), "in", anyLower)
      .orderBy("sys.datetime", "desc")
      .execute();

    const period = await ctx.db
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
      .where((eb) => eb.fn("lower", ["addr.public_key"]), "in", anyLower)
      .orderBy("sys.datetime", "asc")
      .execute();

    for (const r of seed) rows.push({ ...r, timestamp: new Date(r.timestamp), seed: true });
    for (const r of period) rows.push({ ...r, timestamp: new Date(r.timestamp), seed: false });
  }

  const am = new Map<string, AggregatedBalance>();

  for (const a of [...psm3Addrs, ...anySourceAddrs]) {
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

  const seenSeed = new Set<string>();
  for (const r of rows) {
    if (!r.address) continue;
    const k = `${r.chain}:${r.address.toLowerCase()}`;
    const asset = am.get(k);
    if (!asset) continue;

    if (r.seed) {
      if (seenSeed.has(k)) continue;
      seenSeed.add(k);
      asset.symbol = r.symbol;
      asset.snapshots.push({
        timestamp: ctx.periodStart,
        balanceUsd: parseFloat(String(r.totalUsd) || "0"),
      });
    } else {
      asset.symbol = r.symbol;
      asset.snapshots.push({
        timestamp: r.timestamp,
        balanceUsd: parseFloat(String(r.totalUsd) || "0"),
      });
    }
  }

  for (const asset of am.values()) {
    if (asset.snapshots.length > 0) {
      asset.startBalanceUsd = asset.snapshots[0].balanceUsd;
      asset.endBalanceUsd = asset.snapshots[asset.snapshots.length - 1].balanceUsd;
    }
  }

  return Array.from(am.values()).filter((a) => a.snapshots.length > 0);
}

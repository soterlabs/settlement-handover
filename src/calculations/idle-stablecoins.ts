// Idle stablecoins reimbursement — peak Alchemy usage.
//
// For every non-Morpho lending position we issue an eth_call burst at the
// pool (via getSparkLendUtilization / getAaveUtilization) at the period
// midpoint, plus one batch of Curve pool reads per calendar day.
//
// A 30-day window over ~20 positions issues several hundred eth_calls
// (26 CU each on Alchemy) — well within free-tier CUPS when paced through
// the retry/throttle wrappers in support/rpc-utils.ts.

import BigNumber from 'bignumber.js';
import { DateTime } from 'luxon';
import type {
  DebtPnLContext,
  IdleStablecoinsResult,
  CategoryBreakdown,
  AggregatedBalance,
  DailyRow,
} from '../types.ts';
import type { Chain, IdleLendingPosition } from '../constants.ts';
import { getSparkLendUtilization } from '../support/sparklend-utilization.ts';
import { getMorphoVaultUtilization } from '../support/morpho-utilization.ts';
import { getAaveUtilization } from '../support/aave-utilization.ts';
import { getCurvePoolIdleRatio } from '../support/curve-pool-ratio.ts';
import {
  generateDayRanges,
  calculateDailyTimeWeightedAverage,
  type BalanceSnapshot,
} from './daily-calculations.ts';

function apyToPerSecondRate(apyDecimal: number): BigNumber {
  return new BigNumber(Math.pow(1 + apyDecimal, 1 / 31536000) - 1);
}

export async function calculateIdleStablecoins(
  ctx: DebtPnLContext,
  baseRatePercent: number,
): Promise<IdleStablecoinsResult> {
  // The USDC raw-stablecoin entries in IDLE_STABLECOIN_ADDRESSES were all
  // also present in SKY_DIRECT_EXPOSURE_ASSETS — they were filtered out via
  // isSkyDirectExposure. Those pushes are therefore omitted here; what
  // remains is USDS (5 chains) and DAI (ethereum only).
  const sa: Array<{ chain: Chain; address: string }> = [];
  if (ctx.chains.includes('ethereum')) sa.push({ chain: 'ethereum', address: '0xdc035d45d973e3ec169d2276ddab16f1e407384f' }); // USDS
  if (ctx.chains.includes('base'))     sa.push({ chain: 'base',     address: '0x820c137fa70c8691f0e44dc420a5e53c168921dc' }); // USDS
  if (ctx.chains.includes('arbitrum')) sa.push({ chain: 'arbitrum', address: '0x6491c05a82219b8d1479057361ff1654749b876b' }); // USDS
  if (ctx.chains.includes('optimism')) sa.push({ chain: 'optimism', address: '0x4f13a96ec5c4cf34e442b46bbd98a0791f20edc3' }); // USDS
  if (ctx.chains.includes('unichain')) sa.push({ chain: 'unichain', address: '0x7e10036acc4b56d4dfca3b77810356ce52313f9c' }); // USDS
  if (ctx.chains.includes('ethereum')) sa.push({ chain: 'ethereum', address: '0x6b175474e89094c44da98b954eedeac495271d0f' }); // DAI

  let lp: Array<IdleLendingPosition & { chain: Chain }> = [];
  if (ctx.chains.includes('ethereum')) {
    lp.push({ chain: 'ethereum', address: '0x4dedf26112b3ec8ec46e7e31ea5e123490b05b8b', symbol: 'spDAI',               underlyingSymbol: 'DAI',   protocol: 'sparklend' });
    lp.push({ chain: 'ethereum', address: '0x73e65dbd630f90604062f6e02fab9138e713edd9', symbol: 'morpho-DAI',          underlyingSymbol: 'DAI',   protocol: 'morpho' });
    lp.push({ chain: 'ethereum', address: '0xc02ab1a5eaa8d1b114ef786d9bde108cd4364359', symbol: 'spUSDS',              underlyingSymbol: 'USDS',  protocol: 'sparklend' });
    lp.push({ chain: 'ethereum', address: '0xe41a0583334f0dc4e023acd0bfef3667f6fe0597', symbol: 'morpho-USDS',         underlyingSymbol: 'USDS',  protocol: 'morpho' });
    lp.push({ chain: 'ethereum', address: '0x09aa30b182488f769a9824f15e6ce58591da4781', symbol: 'aUSDS',               underlyingSymbol: 'USDS',  protocol: 'aave' });
    lp.push({ chain: 'ethereum', address: '0x32a6268f9ba3642dda7892add74f1d34469a4259', symbol: 'aUSDS',               underlyingSymbol: 'USDS',  protocol: 'aave' });
    lp.push({ chain: 'ethereum', address: '0x00836fe54625be242bcfa286207795405ca4fd10', symbol: 'curve-USDT-LP',       underlyingSymbol: 'USDT',  protocol: 'curve' });
    lp.push({ chain: 'ethereum', address: '0xa632d59b9b804a956bfaa9b48af3a1b74808fc1f', symbol: 'curve-PYUSD-LP',      underlyingSymbol: 'PYUSD', protocol: 'curve' });
    lp.push({ chain: 'ethereum', address: '0x56a76b428244a50513ec81e225a293d128fd581d', symbol: 'morpho-USDC',         underlyingSymbol: 'USDC',  protocol: 'morpho' });
    lp.push({ chain: 'ethereum', address: '0x2bbe31d63e6813e3ac858c04dae43fb2a72b0d11', symbol: 'fsUSDS',              underlyingSymbol: 'USDS',  protocol: 'fluid' });
    lp.push({ chain: 'ethereum', address: '0x38464507e02c983f20428a6e8566693fe9e422a9', symbol: 'arkis-USDC',          underlyingSymbol: 'USDC',  protocol: 'arkis' });
    lp.push({ chain: 'ethereum', address: '0xbeef2b5fd3d94469b7782aebe6364e6e6fb1b709', symbol: 'steakhouse-USDC-v1',  underlyingSymbol: 'USDC',  protocol: 'morpho' });
    lp.push({ chain: 'ethereum', address: '0xbeeff08df54897e7544ab01d0e86f013da354111', symbol: 'steakhouse-USDC-v2',  underlyingSymbol: 'USDC',  protocol: 'morpho' });
    lp.push({ chain: 'ethereum', address: '0xd8a6511979d9c5d387c819e9f8ed9f3a5c6c5379', symbol: 'bbqPYUSD',             underlyingSymbol: 'PYUSD', protocol: 'morpho' });
    lp.push({ chain: 'ethereum', address: '0xbeeff0d672ab7f5018dfb614c93981045d4aa98a', symbol: 'grove-bbqAUSD',        underlyingSymbol: 'AUSD',  protocol: 'morpho' });
    lp.push({ chain: 'ethereum', address: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', symbol: 'aEthUSDC',             underlyingSymbol: 'USDC',  protocol: 'aave' });
    lp.push({ chain: 'ethereum', address: '0xfa82580c16a31d0c1bc632a36f82e83efef3eec0', symbol: 'aEthRLUSD',            underlyingSymbol: 'RLUSD', protocol: 'aave' });
    lp.push({ chain: 'ethereum', address: '0xe3190143eb552456f88464662f0c0c4ac67a77eb', symbol: 'aHorRwaRLUSD',         underlyingSymbol: 'RLUSD', protocol: 'aave' });
    lp.push({ chain: 'ethereum', address: '0x68215b6533c47ff9f7125ac95adf00fe4a62f79e', symbol: 'aEthUSDC-grove',       underlyingSymbol: 'USDC',  protocol: 'aave' });
    lp.push({ chain: 'ethereum', address: '0xe79c1c7e24755574438a26d5e062ad2626c04662', symbol: 'curve-AUSD-LP',        underlyingSymbol: 'AUSD',  protocol: 'curve' });
  }
  if (ctx.chains.includes('base')) {
    lp.push({ chain: 'base', address: '0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a', symbol: 'morpho-USDC',             underlyingSymbol: 'USDC', protocol: 'morpho' });
    lp.push({ chain: 'base', address: '0xbeef2d50b428675a1921bc6bbf4bfb9d8cf1461a', symbol: 'steakhouse-USDC-base',    underlyingSymbol: 'USDC', protocol: 'morpho' });
    lp.push({ chain: 'base', address: '0xbeef0e0834849acc03f0089f01f4f1eeb06873c9', symbol: 'steakhouse-USDC-base-v2', underlyingSymbol: 'USDC', protocol: 'morpho' });
    lp.push({ chain: 'base', address: '0xf62e339f21d8018940f188f6987bcdf02a849619', symbol: 'fluid-sUSDS',             underlyingSymbol: 'USDS', protocol: 'fluid' });
    lp.push({ chain: 'base', address: '0x4e65fe4dba92790696d040ac24aa414708f5c0ab', symbol: 'aBasUSDC',                underlyingSymbol: 'USDC', protocol: 'aave' });
  }
  if (ctx.chains.includes('arbitrum')) {
    lp.push({ chain: 'arbitrum', address: '0x3459fcc94390c3372c0f7b4cd3f8795f0e5afe96', symbol: 'fluid-sUSDS', underlyingSymbol: 'USDS', protocol: 'fluid' });
    lp.push({ chain: 'arbitrum', address: '0x724dc807b04555b71ed48a6896b6f41593b8c637', symbol: 'aArbUSDC',   underlyingSymbol: 'USDC', protocol: 'aave' });
  }
  if (ctx.chains.includes('avalanche')) {
    lp.push({ chain: 'avalanche', address: '0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d', symbol: 'spark-USDC', underlyingSymbol: 'USDC', protocol: 'sparklend' });
    lp.push({ chain: 'avalanche', address: '0x625e7708f30ca75bfd92586e17077590c60eb4cd', symbol: 'aAvaUSDC',  underlyingSymbol: 'USDC', protocol: 'aave' });
  }
  if (ctx.chains.includes('monad')) {
    lp.push({ chain: 'monad', address: '0x32841A8511D5c2c5b253f45668780B99139e476D', symbol: 'morpho-AUSD', underlyingSymbol: 'AUSD', protocol: 'morpho' });
  }

  if (
    DateTime.fromJSDate(ctx.periodStart, { zone: 'utc' }) <
      DateTime.fromISO('2025-11-01', { zone: 'utc' })
  ) {
    lp = lp.filter((p) => !(p.protocol === 'curve' && p.underlyingSymbol === 'USDT'));
  }

  const all = [
    ...sa,
    ...lp.map((p) => ({ chain: p.chain, address: p.address.toLowerCase() })),
  ];

  if (all.length === 0) {
    return {
      averageBalanceUsd: 0,
      reimbursementUsd: 0,
      breakdown: [],
      dailyRows: [],
      lendingDailyRows: [],
      curveUsdsDailyRows: [],
      curveSusdsDailyRows: [],
      curveSdeDailyRows: [],
    };
  }

  const ab = await fetchAssetBalances(ctx, all);

  const lm = new Map<string, IdleLendingPosition & { chain: Chain }>();
  for (const p of lp) {
    lm.set(`${p.chain}:${p.address.toLowerCase()}`, p);
  }

  const dr = generateDayRanges(ctx.periodStart, ctx.periodEnd);

  // Period midpoint for utilization snapshots — one Alchemy call batch per
  // protocol at a single historical block.
  const mid = Math.floor(
    (ctx.periodStart.getTime() + ctx.periodEnd.getTime()) / 2 / 1000,
  );
  const dt = dr.map((d) => Math.floor(d.dayStart.getTime() / 1000));

  const su = new Map<string, { idleRatio: number }>();
  for (const p of lp.filter((x) => x.protocol === 'sparklend')) {
    try {
      const u = await getSparkLendUtilization(p.address, mid, p.chain);
      if (u) su.set(p.address.toLowerCase(), { idleRatio: u.idleRatio });
    } catch (e) {
      console.error(`Failed to fetch utilization for ${p.symbol}:`, e);
    }
  }

  const mu = new Map<string, { idleRatio: number }>();
  for (const p of lp.filter((x) => x.protocol === 'morpho')) {
    const chainId = p.chain === 'ethereum' ? 1
      : p.chain === 'base' ? 8453
      : p.chain === 'arbitrum' ? 42161
      : p.chain === 'optimism' ? 10
      : p.chain === 'unichain' ? 130
      : p.chain === 'avalanche' ? 43114
      : p.chain === 'plume' ? 98865
      : 10143; // monad
    try {
      const u = await getMorphoVaultUtilization(p.address, chainId, mid);
      if (u) mu.set(p.address.toLowerCase(), { idleRatio: u.idleRatio });
    } catch (e) {
      console.error(`Failed to fetch Morpho utilization for ${p.symbol}:`, e);
    }
  }

  const au = new Map<string, { idleRatio: number }>();
  for (const p of lp.filter((x) => x.protocol === 'aave')) {
    try {
      const u = await getAaveUtilization(p.address, p.chain, mid);
      if (u) au.set(p.address.toLowerCase(), { idleRatio: u.idleRatio });
    } catch (e) {
      console.error(`Failed to fetch Aave utilization for ${p.symbol} on ${p.chain}:`, e);
    }
  }

  const cu = new Map<string, number[]>();
  for (const p of lp.filter((x) => x.protocol === 'curve')) {
    const arr: number[] = [];
    for (const ts of dt) {
      try {
        const u = await getCurvePoolIdleRatio(p.address, ts);
        arr.push(u?.idleRatio ?? 1);
      } catch (e) {
        console.error(`Failed to fetch Curve pool ratio for ${p.symbol} at ${ts}:`, e);
        arr.push(1);
      }
    }
    cu.set(p.address.toLowerCase(), arr);
  }

  const brps = apyToPerSecondRate(baseRatePercent / 100);
  const bra = baseRatePercent / 100;
  const ssa = 30 / 10000;
  const ssps = apyToPerSecondRate(ssa);

  let tr = new BigNumber(0);
  let tab = new BigNumber(0);
  const breakdown: CategoryBreakdown[] = [];
  const almDailyRows: DailyRow[] = [];
  const lendingDailyRows: DailyRow[] = [];
  const curveUsdsDailyRows: DailyRow[] = [];
  const curveSusdsDailyRows: DailyRow[] = [];
  const curveSdeDailyRows: DailyRow[] = [];

  for (const asset of ab) {
    const pos = lm.get(`${asset.chain}:${asset.address.toLowerCase()}`);

    let ir = 1;
    let dcr: number[] | null = null;

    if (pos) {
      if (pos.protocol === 'sparklend') {
        const u = su.get(pos.address.toLowerCase());
        if (u) ir = u.idleRatio;
      } else if (pos.protocol === 'morpho') {
        const u = mu.get(pos.address.toLowerCase());
        if (u) ir = u.idleRatio;
      } else if (pos.protocol === 'aave') {
        const u = au.get(pos.address.toLowerCase());
        if (u) ir = u.idleRatio;
      } else if (pos.protocol === 'curve') {
        dcr = cu.get(pos.address.toLowerCase()) ?? null;
      }
    }

    const snaps: BalanceSnapshot[] = asset.snapshots.map((s) => ({
      timestamp: s.timestamp,
      balanceUsd: s.balanceUsd * (dcr ? 1 : ir),
    }));

    const isCurve = pos?.protocol === 'curve';
    const raw: BalanceSnapshot[] = isCurve
      ? asset.snapshots.map((s) => ({ timestamp: s.timestamp, balanceUsd: s.balanceUsd }))
      : [];

    let ar = new BigNumber(0);
    let atb = new BigNumber(0);
    let db = 0;
    const isLending = !!pos;
    const rows = isCurve ? null : isLending ? lendingDailyRows : almDailyRows;

    for (let i = 0; i < dr.length; i++) {
      const day = dr[i];
      let v = calculateDailyTimeWeightedAverage(snaps, day.dayStart, day.dayEnd);

      if (dcr) v *= dcr[i] ?? 1;

      const isPy = pos?.underlyingSymbol === 'PYUSD';
      if (v > 0 && !isPy) {
        const di = new BigNumber(v).multipliedBy(brps).multipliedBy(86400);

        ar = ar.plus(di);
        atb = atb.plus(v);
        db++;

        if (rows) {
          const row: DailyRow = {
            date: DateTime.fromJSDate(day.dayStart, { zone: 'utc' }).toFormat('yyyy-MM-dd'),
            network: asset.chain,
            averageBalance: v,
            apr: bra,
            dailyInterest: di.toNumber(),
          };
          if (isLending && pos) row.type = pos.protocol;
          rows.push(row);
        }
      }

      if (isCurve && dcr) {
        const fb = calculateDailyTimeWeightedAverage(raw, day.dayStart, day.dayEnd);
        const sr = dcr[i] ?? 1;
        const sur = 1 - sr;
        const ds = DateTime.fromJSDate(day.dayStart, { zone: 'utc' }).toFormat('yyyy-MM-dd');

        if (pos?.underlyingSymbol === 'USDT') {
          const ub = fb * sr;
          if (ub > 0) {
            const ui = new BigNumber(ub).multipliedBy(brps).multipliedBy(86400);
            curveSdeDailyRows.push({
              date: ds,
              network: 'ethereum',
              averageBalance: ub,
              apr: bra,
              dailyInterest: ui.toNumber(),
            });
          }

          const sb = fb * sur;
          if (sb > 0) {
            const si = new BigNumber(sb).multipliedBy(ssps).multipliedBy(86400);
            curveSusdsDailyRows.push({
              date: ds,
              network: 'ethereum',
              averageBalance: sb,
              apr: ssa,
              dailyInterest: si.toNumber(),
            });
          }
        } else if (pos?.underlyingSymbol === 'PYUSD') {
          const sb = fb * sur;
          if (sb > 0) {
            const si = new BigNumber(sb).multipliedBy(brps).multipliedBy(86400);
            curveUsdsDailyRows.push({
              date: ds,
              network: 'ethereum',
              averageBalance: sb,
              apr: bra,
              dailyInterest: si.toNumber(),
            });
          }
        }
      }
    }

    const avg = db > 0 ? atb.dividedBy(db).toNumber() : 0;

    tr = tr.plus(ar);
    tab = tab.plus(avg);

    const car = dcr ? dcr.reduce((a, b) => a + b, 0) / dcr.length : ir;

    breakdown.push({
      network: asset.chain,
      address: asset.address,
      symbol: pos?.symbol ?? asset.symbol,
      averageBalanceUsd: avg,
      startBalanceUsd: asset.startBalanceUsd * car,
      endBalanceUsd: asset.endBalanceUsd * car,
      reimbursementUsd: ar.toNumber(),
      idleRatio: dcr ? car : ir,
      protocol: pos?.protocol ?? 'stablecoin',
    });
  }

  return {
    averageBalanceUsd: tab.toNumber(),
    reimbursementUsd: tr.toNumber(),
    breakdown,
    dailyRows: almDailyRows,
    lendingDailyRows,
    curveUsdsDailyRows,
    curveSusdsDailyRows,
    curveSdeDailyRows,
  };
}

async function fetchAssetBalances(
  ctx: DebtPnLContext,
  ta: Array<{ chain: Chain; address: string }>,
): Promise<AggregatedBalance[]> {
  const al = ta.map((t) => t.address.toLowerCase());

  const sq = ctx.db
    .selectFrom('star_allocation_system_assets as a')
    .innerJoin('star_allocation_systems as sys', 'sys.id', 'a.star_allocation_system_id')
    .innerJoin('tokens as t', 't.id', 'a.token_id')
    .innerJoin('addresses as addr', 'addr.id', 't.address_id')
    .innerJoin('networks as n', 'n.id', 'addr.network_id')
    .select([
      'n.name as chain',
      'addr.public_key as address',
      't.symbol as symbol',
      'a.total_usd as totalUsd',
      'sys.datetime as timestamp',
    ])
    .where('sys.star_id', '=', ctx.starId)
    .where('sys.datetime', '<', ctx.periodStart)
    .where('a.source', '=', 'alm')
    .where((eb) => eb.fn('lower', ['addr.public_key']), 'in', al)
    .orderBy('sys.datetime', 'desc');

  const pq = ctx.db
    .selectFrom('star_allocation_system_assets as a')
    .innerJoin('star_allocation_systems as sys', 'sys.id', 'a.star_allocation_system_id')
    .innerJoin('tokens as t', 't.id', 'a.token_id')
    .innerJoin('addresses as addr', 'addr.id', 't.address_id')
    .innerJoin('networks as n', 'n.id', 'addr.network_id')
    .select([
      'n.name as chain',
      'addr.public_key as address',
      't.symbol as symbol',
      'a.total_usd as totalUsd',
      'sys.datetime as timestamp',
    ])
    .where('sys.star_id', '=', ctx.starId)
    .where('sys.datetime', '>=', ctx.periodStart)
    .where('sys.datetime', '<=', ctx.periodEnd)
    .where('a.source', '=', 'alm')
    .where((eb) => eb.fn('lower', ['addr.public_key']), 'in', al)
    .orderBy('sys.datetime', 'asc');

  const [seedRows, periodRows] = await Promise.all([sq.execute(), pq.execute()]);

  const am = new Map<string, AggregatedBalance>();

  for (const a of ta) {
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

  const sba = new Map<string, (typeof seedRows)[0]>();
  for (const r of seedRows) {
    if (!r.address) continue;
    const k = `${r.chain}:${r.address.toLowerCase()}`;
    if (!sba.has(k)) sba.set(k, r);
  }

  for (const [k, asset] of am) {
    const s = sba.get(k);
    if (s) {
      asset.symbol = s.symbol;
      asset.snapshots.push({
        timestamp: ctx.periodStart,
        balanceUsd: parseFloat(String(s.totalUsd) || '0'),
      });
    }
  }

  for (const r of periodRows) {
    if (!r.address) continue;
    const asset = am.get(`${r.chain}:${r.address.toLowerCase()}`);
    if (asset) {
      asset.symbol = r.symbol;
      asset.snapshots.push({
        timestamp: new Date(r.timestamp),
        balanceUsd: parseFloat(String(r.totalUsd) || '0'),
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

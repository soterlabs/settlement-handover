// ---------------------------------------------------------------------------
// Sky Savings Rate (SSR) calculation helpers.
//
// These helpers do NOT call Alchemy — they read pre-indexed SSR events and
// price series from the Supabase database via Kysely. That's an intentional
// architectural choice: the SSR event stream is ingested by a background
// process (typically an Alchemy webhook or GraphNode subgraph listener)
// into Postgres, and this module only does the time-weighted arithmetic.
//
// If you were to bypass the Supabase mirror and hit Alchemy directly, the
// equivalent reads would be:
//
//   • `eth_getLogs` with a topic filter for the SSR-update event
//     (60 CU per call, or 75 CU for newer `eth_newFilter`-backed methods).
//   • Pagination in 10k-block windows to stay within Alchemy's response
//     cap (~10k logs per response).
//
// Deno notes:
//   • `DateTime` from `npm:luxon` works identically here as in Node.
//   • `import('./addresses.ts')` (dynamic import at the bottom) is the
//     standard ESM spelling; Deno's module loader resolves it the same way
//     as a static import.
// ---------------------------------------------------------------------------

import type { Kysely } from 'kysely';
import type { SupabaseDB } from '../db/schema.ts';
import type { Chain } from '../constants.ts';
import BigNumber from 'bignumber.js';
import { DateTime } from 'luxon';

function toNullableNumber(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const p = Number(t);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

async function getAssetTimeline(
  db: Kysely<SupabaseDB>,
  starId: number,
  chain: Chain,
  address: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<
  Array<{
    timestamp: Date;
    valueUsd: BigNumber;
    quantity: BigNumber;
    priceUsd: BigNumber;
  }>
> {
  const rows = await db
    .selectFrom('star_allocation_system_assets as a')
    .innerJoin(
      'star_allocation_systems as sys',
      'sys.id',
      'a.star_allocation_system_id',
    )
    .innerJoin('tokens as t', 't.id', 'a.token_id')
    .innerJoin('addresses as addr', 'addr.id', 't.address_id')
    .innerJoin('networks as n', 'n.id', 'addr.network_id')
    .select([
      'a.total_usd',
      'a.quantity',
      'a.price_usd',
      'sys.datetime as timestamp',
    ])
    .where('sys.star_id', '=', starId)
    .where('n.name', '=', chain)
    .where('addr.public_key', '=', address)
    .where('sys.datetime', '>=', periodStart)
    .where('sys.datetime', '<', periodEnd)
    .orderBy('sys.datetime', 'asc')
    .execute();

  return rows.map((r) => ({
    timestamp: r.timestamp instanceof Date
      ? r.timestamp
      : new Date(String(r.timestamp)),
    valueUsd: new BigNumber(toNullableNumber(r.total_usd) ?? 0),
    quantity: new BigNumber(r.quantity ? String(r.quantity) : 0),
    priceUsd: new BigNumber(toNullableNumber(r.price_usd) ?? 0),
  }));
}

export interface SSRCalculationResult {
  customBaseRate: number | null;
  periodReturn: number | null;
  apy: number | null;
  apr: number | null;
}

export async function calculateUsdsSSRMetrics(
  db: Kysely<SupabaseDB>,
  starId: number,
  chain: Chain,
  address: string,
  periodStart: Date,
  periodEnd: Date,
  periodDays: number | null,
): Promise<SSRCalculationResult> {
  const res: SSRCalculationResult = {
    customBaseRate: null,
    periodReturn: null,
    apy: null,
    apr: null,
  };

  if (chain !== 'ethereum') {
    return res;
  }

  try {
    const sbs = await db
      .selectFrom('star_allocation_system_assets as a')
      .innerJoin(
        'star_allocation_systems as sys',
        'sys.id',
        'a.star_allocation_system_id',
      )
      .innerJoin('tokens as t', 't.id', 'a.token_id')
      .innerJoin('addresses as addr', 'addr.id', 't.address_id')
      .select(['a.price_usd', 'sys.datetime as timestamp'])
      .where('sys.star_id', '=', starId)
      .where('addr.public_key', '=', '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd')
      .where('sys.datetime', '<', periodStart)
      .orderBy('sys.datetime', 'desc')
      .limit(1)
      .execute();

    const sep = await db
      .selectFrom('star_allocation_system_assets as a')
      .innerJoin(
        'star_allocation_systems as sys',
        'sys.id',
        'a.star_allocation_system_id',
      )
      .innerJoin('tokens as t', 't.id', 'a.token_id')
      .innerJoin('addresses as addr', 'addr.id', 't.address_id')
      .select(['a.price_usd', 'sys.datetime as timestamp'])
      .where('sys.star_id', '=', starId)
      .where('addr.public_key', '=', '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd')
      .where('sys.datetime', '>=', periodStart)
      .where('sys.datetime', '<', periodEnd)
      .orderBy('sys.datetime', 'desc')
      .limit(1)
      .execute();

    if (sbs.length > 0 && sep.length > 0) {
      const sp = new BigNumber(toNullableNumber(sbs[0].price_usd) ?? 0);
      const ep = new BigNumber(toNullableNumber(sep[0].price_usd) ?? 0);

      const st = sbs[0].timestamp instanceof Date
        ? sbs[0].timestamp
        : new Date(String(sbs[0].timestamp));
      const et = sep[0].timestamp instanceof Date
        ? sep[0].timestamp
        : new Date(String(sep[0].timestamp));

      const ad = (et.getTime() - st.getTime()) / (1000 * 60 * 60 * 24);

      if (sp.gt(0) && ad > 0) {
        const pr = ep.minus(sp).div(sp).multipliedBy(100);
        const apy = (Math.pow(1 + pr.toNumber() / 100, 365 / ad) - 1) * 100;
        res.customBaseRate = apy;
      }
    }

    const spbs = await db
      .selectFrom('star_allocation_system_assets as a')
      .innerJoin(
        'star_allocation_systems as sys',
        'sys.id',
        'a.star_allocation_system_id',
      )
      .innerJoin('tokens as t', 't.id', 'a.token_id')
      .innerJoin('addresses as addr', 'addr.id', 't.address_id')
      .select(['a.price_usd'])
      .where('sys.star_id', '=', starId)
      .where('addr.public_key', '=', address)
      .where('sys.datetime', '<', periodStart)
      .orderBy('sys.datetime', 'desc')
      .limit(1)
      .execute();

    const pt = await getAssetTimeline(
      db,
      starId,
      chain,
      address,
      periodStart,
      periodEnd,
    );

    if (pt.length >= 1 && spbs.length > 0) {
      const fp = new BigNumber(toNullableNumber(spbs[0].price_usd) ?? 0);
      const lp = pt[pt.length - 1].priceUsd;

      if (fp.gt(0)) {
        const sppr = lp.minus(fp).div(fp).multipliedBy(100);

        if (
          res.customBaseRate !== null &&
          sbs.length > 0 &&
          sep.length > 0
        ) {
          const ssp = new BigNumber(toNullableNumber(sbs[0].price_usd) ?? 0);
          const sepp = new BigNumber(toNullableNumber(sep[0].price_usd) ?? 0);

          if (ssp.gt(0)) {
            const sprp = sepp.minus(ssp).div(ssp).multipliedBy(100);

            if (sppr.lt(sprp) && sprp.gt(0)) {
              const ar = sppr.div(sprp);
              res.periodReturn = sppr.multipliedBy(ar).toNumber();
            } else {
              res.periodReturn = sppr.toNumber();
            }
          } else {
            res.periodReturn = sppr.toNumber();
          }
        } else {
          res.periodReturn = sppr.toNumber();
        }

        if (periodDays && periodDays > 0 && res.periodReturn !== null) {
          const mr = res.periodReturn / 100;
          const ar = Math.pow(1 + mr, 365 / periodDays) - 1;
          res.apy = ar * 100;

          res.apr = (res.periodReturn / periodDays) * 365;
        }
      }
    }
  } catch {
    // swallow — SSR metrics are best-effort; callers treat null as "no data"
  }

  return res;
}

export async function calculateSSRForPeriod(
  db: Kysely<SupabaseDB>,
  starId: number,
  periodStart: Date,
  periodEnd: Date,
): Promise<number | null> {
  try {
    const sbs = await db
      .selectFrom('star_allocation_system_assets as a')
      .innerJoin(
        'star_allocation_systems as sys',
        'sys.id',
        'a.star_allocation_system_id',
      )
      .innerJoin('tokens as t', 't.id', 'a.token_id')
      .innerJoin('addresses as addr', 'addr.id', 't.address_id')
      .select(['a.price_usd', 'sys.datetime as timestamp'])
      .where('sys.star_id', '=', starId)
      .where('addr.public_key', '=', '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd')
      .where('sys.datetime', '<', periodStart)
      .orderBy('sys.datetime', 'desc')
      .limit(1)
      .execute();

    const sep = await db
      .selectFrom('star_allocation_system_assets as a')
      .innerJoin(
        'star_allocation_systems as sys',
        'sys.id',
        'a.star_allocation_system_id',
      )
      .innerJoin('tokens as t', 't.id', 'a.token_id')
      .innerJoin('addresses as addr', 'addr.id', 't.address_id')
      .select(['a.price_usd', 'sys.datetime as timestamp'])
      .where('sys.star_id', '=', starId)
      .where('addr.public_key', '=', '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd')
      .where('sys.datetime', '>=', periodStart)
      .where('sys.datetime', '<', periodEnd)
      .orderBy('sys.datetime', 'desc')
      .limit(1)
      .execute();

    if (sbs.length > 0 && sep.length > 0) {
      const sp = new BigNumber(toNullableNumber(sbs[0].price_usd) ?? 0);
      const ep = new BigNumber(toNullableNumber(sep[0].price_usd) ?? 0);

      const st = sbs[0].timestamp instanceof Date
        ? sbs[0].timestamp
        : new Date(String(sbs[0].timestamp));
      const et = sep[0].timestamp instanceof Date
        ? sep[0].timestamp
        : new Date(String(sep[0].timestamp));

      const ad = (et.getTime() - st.getTime()) / (1000 * 60 * 60 * 24);

      if (sp.gt(0) && ad > 0) {
        const pr = ep.minus(sp).div(sp).multipliedBy(100);
        const apy = (Math.pow(1 + pr.toNumber() / 100, 365 / ad) - 1) * 100;
        return apy;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function calculateWeightedSSRFromEvents(
  db: Kysely<SupabaseDB>,
  periodStart: Date,
  periodEnd: Date,
): Promise<number | null> {
  try {
    const psd = DateTime.fromJSDate(periodStart, { zone: 'utc' });
    const ped = DateTime.fromJSDate(periodEnd, { zone: 'utc' });
    const tpm = ped.diff(psd).as('milliseconds');

    if (tpm <= 0) {
      return null;
    }

    const ebp = await db
      .selectFrom('ssr_event_integration_boost')
      .select(['data', 'timestamp'])
      .where('timestamp', '<', periodStart)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .execute();

    const eip = await db
      .selectFrom('ssr_event_integration_boost')
      .select(['data', 'timestamp'])
      .where('timestamp', '>=', periodStart)
      .where('timestamp', '<', periodEnd)
      .orderBy('timestamp', 'asc')
      .execute();

    if (ebp.length === 0 && eip.length === 0) {
      return null;
    }

    const segs: { rate: number; durationMs: number }[] = [];

    let cr: number | null = null;
    let ss = psd;

    if (ebp.length > 0 && ebp[0].data !== null) {
      cr = ebp[0].data;
    }

    for (const ev of eip) {
      const et = DateTime.fromJSDate(
        ev.timestamp instanceof Date
          ? ev.timestamp
          : new Date(String(ev.timestamp)),
        { zone: 'utc' },
      );

      if (cr !== null) {
        const dm = et.diff(ss).as('milliseconds');
        if (dm > 0) {
          segs.push({ rate: cr, durationMs: dm });
        }
      }

      cr = ev.data;
      ss = et;
    }

    if (cr !== null) {
      const dm = ped.diff(ss).as('milliseconds');
      if (dm > 0) {
        segs.push({ rate: cr, durationMs: dm });
      }
    }

    if (segs.length === 0) {
      return null;
    }

    let twr = 0;
    let td = 0;

    for (const s of segs) {
      twr += s.rate * s.durationMs;
      td += s.durationMs;
    }

    if (td === 0) {
      return null;
    }

    const wa = twr / td;
    return wa * 100;
  } catch {
    return null;
  }
}

export interface SSRSegment {
  startTime: Date;
  endTime: Date;
  ratePercent: number;
  rawSsr: string | null;
  durationMs: number;
}

export async function getSSRSegments(
  db: Kysely<SupabaseDB>,
  periodStart: Date,
  periodEnd: Date,
): Promise<SSRSegment[]> {
  const psd = DateTime.fromJSDate(periodStart, { zone: 'utc' });
  const ped = DateTime.fromJSDate(periodEnd, { zone: 'utc' });

  const ebp = await db
    .selectFrom('ssr_event_integration_boost')
    .select(['data', 'raw_ssr', 'timestamp'])
    .where('timestamp', '<', periodStart)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .execute();

  const eip = await db
    .selectFrom('ssr_event_integration_boost')
    .select(['data', 'raw_ssr', 'timestamp'])
    .where('timestamp', '>=', periodStart)
    .where('timestamp', '<', periodEnd)
    .orderBy('timestamp', 'asc')
    .execute();

  const segs: SSRSegment[] = [];

  let cr: number | null = null;
  let crs: string | null = null;
  let ss = psd;

  if (ebp.length > 0 && ebp[0].data !== null) {
    cr = ebp[0].data;
    crs = ebp[0].raw_ssr ?? null;
  }

  for (const ev of eip) {
    const et = DateTime.fromJSDate(
      ev.timestamp instanceof Date
        ? ev.timestamp
        : new Date(String(ev.timestamp)),
      { zone: 'utc' },
    );

    if (cr !== null) {
      const dm = et.diff(ss).as('milliseconds');
      if (dm > 0) {
        segs.push({
          startTime: ss.toJSDate(),
          endTime: et.toJSDate(),
          ratePercent: cr * 100,
          rawSsr: crs,
          durationMs: dm,
        });
      }
    }

    cr = ev.data;
    crs = ev.raw_ssr ?? null;
    ss = et;
  }

  if (cr !== null) {
    const dm = ped.diff(ss).as('milliseconds');
    if (dm > 0) {
      segs.push({
        startTime: ss.toJSDate(),
        endTime: ped.toJSDate(),
        ratePercent: cr * 100,
        rawSsr: crs,
        durationMs: dm,
      });
    }
  }

  return segs;
}

export async function calculateBaseRateForPeriod(
  db: Kysely<SupabaseDB>,
  starId: number,
  periodStart: Date,
  periodEnd: Date,
  spreadBps: number = 30,
): Promise<number> {
  const ws = await calculateWeightedSSRFromEvents(db, periodStart, periodEnd);
  if (ws !== null) return ws + spreadBps / 100;

  const apy = await calculateSSRForPeriod(db, starId, periodStart, periodEnd);
  if (apy !== null) return apy + spreadBps / 100;

  return 4.66;
}

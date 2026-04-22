// ---------------------------------------------------------------------------
// HTTP handler — same Request/Response signature as the Node version. In
// Deno you can plug this straight into `Deno.serve((req) => GET(db, req))`
// without any adapter layer, because both `Request` and `Response` are the
// standard WHATWG Fetch types that Deno implements natively.
//
// Deno notes:
//   • `Deno.serve` is the built-in HTTP server (Deno 1.35+). It's a single
//     function call — no `http.createServer`, no framework required.
//   • The `Request`/`Response` types here are GLOBAL in Deno (from
//     lib.deno.window.d.ts), so no import is needed for them.
// ---------------------------------------------------------------------------

import type { Kysely } from 'kysely';
import type { SupabaseDB } from '../db/schema.ts';
import { calculateDebtPnL, parsePeriodParams } from '../service.ts';
import type { Chain } from '../constants.ts';

export async function GET(
  db: Kysely<SupabaseDB>,
  request: Request,
  params: { star: string },
) {
  try {
    const star = params.star;
    if (!star) {
      return new Response(JSON.stringify({ error: 'Star name is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const u = new URL(request.url);
    const sp = u.searchParams.get('start');
    const ep = u.searchParams.get('end');
    const mp = u.searchParams.get('month');
    const cp = u.searchParams.get('chains');

    const { startDate, endDate } = parsePeriodParams({
      start: sp ?? undefined,
      end: ep ?? undefined,
      month: mp ?? undefined,
    });

    const chains: Chain[] | undefined = cp
      ? (cp.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) as Chain[])
      : undefined;

    const r = await calculateDebtPnL(db, {
      star,
      startDate,
      endDate,
      chains,
    });

    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('Star not found')) {
      return new Response(JSON.stringify({ error: 'Star not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    console.error('Error calculating debt-based PnL:', e);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: e instanceof Error ? e.message : 'Unknown error',
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}

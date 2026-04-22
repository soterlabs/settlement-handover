import { Hono } from 'hono';
import { GET as updateDistributionRewards } from './update-distribution-rewards-calculations/route.ts';

const app = new Hono();

app.get('/', (c) => c.text('settlement-handover is running'));

// Wire the migrated Next.js route handler onto the Hono router.
// The handler signature is (req: Request) => Promise<Response>, which
// matches what Hono expects when we pass `c.req.raw` through.
app.get('/api/update-distribution-rewards', (c) => updateDistributionRewards(c.req.raw));

const port = Number(Deno.env.get('PORT') ?? 8000);
Deno.serve({ port }, app.fetch);
console.log(`Listening on http://localhost:${port}`);
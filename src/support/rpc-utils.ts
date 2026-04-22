// ---------------------------------------------------------------------------
// RPC helpers: retry with backoff, throttling, 429 detection.
//
// Why this module exists: Alchemy caps throughput in Compute Units per
// Second (CUPS). When a burst of `eth_call`s pushes you over the ceiling,
// Alchemy responds with HTTP 429 (or a JSON-RPC error with `code: 429` and
// a message containing "compute units per second"). Retrying with
// exponential backoff — which is what `retryWithBackoff` below does — is
// the supported recovery pattern.
//
// Deno notes:
//   • `setTimeout`, `Date`, `Map`, Promises and the `fetch` API are Web
//     standards baked into Deno's runtime. Nothing here needs a polyfill,
//     and no `--allow-*` flag is required for timers/maps.
//   • The ambient globals match browser semantics, so the same code runs
//     unchanged in Deno Deploy (Alchemy's own edge-worker competitor).
// ---------------------------------------------------------------------------

import type { Chain } from '../constants.ts';

export async function sleep(ms: number): Promise<void> {
  // Standard WHATWG timer. Deno's event loop handles this the same way
  // Node does, but without the N-API / libuv boundary.
  return new Promise((r) => setTimeout(r, ms));
}

export function is429Error(error: unknown): boolean {
  // Alchemy surfaces rate-limit failures in several shapes depending on
  // whether ethers or a raw fetch caught the error — we normalise across
  // them here.
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (e.code === 429) return true;
    if (typeof e.error === 'object' && e.error !== null) {
      const ne = e.error as Record<string, unknown>;
      if (ne.code === 429) return true;
    }
    if (typeof e.message === 'string') {
      if (e.message.includes('compute units per second')) return true;
      if (e.message.includes('429')) return true;
    }
  }
  return false;
}

export function isRetryableError(error: unknown): boolean {
  if (is429Error(error)) return true;

  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;

    // ethers.js error taxonomy. CALL_EXCEPTION is ambiguous — it can mean
    // a genuinely reverted contract call (not retryable) OR a transient
    // upstream hiccup from Alchemy. We default to retryable because the
    // calculation code treats a final failure as "no data, skip asset".
    if (e.code === 'CALL_EXCEPTION') return true;
    if (e.code === 'TIMEOUT') return true;
    if (e.code === 'NETWORK_ERROR') return true;
    if (e.code === 'SERVER_ERROR') return true;

    if (typeof e.message === 'string') {
      const m = e.message.toLowerCase();
      if (m.includes('missing revert data')) return true;
      if (m.includes('timeout')) return true;
      if (m.includes('network')) return true;
      if (m.includes('connection')) return true;
      if (m.includes('socket hang up')) return true;
      if (m.includes('econnreset')) return true;
    }
  }

  return false;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  initialDelay = 1000,
): Promise<T> {
  let le: unknown;

  for (let a = 0; a <= maxRetries; a++) {
    try {
      return await fn();
    } catch (err) {
      le = err;

      if (isRetryableError(err) && a < maxRetries) {
        // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s. This pairs
        // naturally with Alchemy's per-second CUPS window, because the
        // first retry typically lands in a fresh second and recovers.
        const d = initialDelay * Math.pow(2, a);
        await sleep(d);
        continue;
      }

      throw err;
    }
  }

  throw le;
}

// Per-chain soft throttle. Alchemy's rate limit is global to your API key,
// but each chain has its own price map, so keeping per-chain pacing gives
// us a simple way to avoid bursting any single endpoint.
const lastRpcCallByChain = new Map<Chain, number>();

export async function throttledRpcCall<T>(
  fn: () => Promise<T>,
  chain?: Chain,
  delayMs = 50,
): Promise<T> {
  const n = Date.now();
  const lc = chain ? (lastRpcCallByChain.get(chain) ?? 0) : 0;
  const d = n - lc;

  if (d < delayMs) {
    await sleep(delayMs - d);
  }

  if (chain) {
    lastRpcCallByChain.set(chain, Date.now());
  }
  return await fn();
}

let lastGlobalRpcCall = 0;

export async function rateLimited<T>(
  fn: () => Promise<T>,
  rateLimitMs = 100,
): Promise<T> {
  const w = Math.max(0, rateLimitMs - (Date.now() - lastGlobalRpcCall));
  if (w) await sleep(w);
  const r = await fn();
  lastGlobalRpcCall = Date.now();
  return r;
}

export async function rpcCallWithRetry<T>(
  fn: () => Promise<T>,
  chain?: Chain,
  maxRetries = 5,
  throttleMs = 50,
): Promise<T> {
  return throttledRpcCall(
    () => retryWithBackoff(fn, maxRetries),
    chain,
    throttleMs,
  );
}

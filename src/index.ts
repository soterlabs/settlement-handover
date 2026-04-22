// ---------------------------------------------------------------------------
// Public entry point of the debt-pnl library.
//
// Deno note: relative imports MUST include the `.ts` extension. Unlike Node's
// bundler-style resolution, Deno does not probe for index.ts or imply .ts —
// the URL you write is the URL it loads. This makes modules self-describing
// and removes any dependency on a tsconfig `paths` mapping.
// ---------------------------------------------------------------------------

export * from './types.ts';
export * from './constants.ts';
export * from './service.ts';

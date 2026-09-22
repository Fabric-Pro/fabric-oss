/**
 * The size ceiling on one synced context file. Kept apart from
 * `upsert-synced-context.ts` so the v1 route can size its body envelope from
 * it without loading the Temporal client and the realtime emitter at module
 * load.
 */

/**
 * The most UTF-8 bytes one synced file may carry: the same 2 MiB ceiling the
 * coding-instructions inline change set uses (`MAX_INLINE_CHANGE_BYTES` in
 * `procedures/instructions/submit-change.ts`), for the same reason — a 4.5 MB
 * serverless request body, which JSON escaping eats into.
 */
export const MAX_SYNCED_CONTEXT_BYTES = 2 * 1024 * 1024;

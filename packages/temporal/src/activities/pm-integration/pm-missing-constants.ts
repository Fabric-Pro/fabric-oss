/**
 * Shared PM "missing ticket" sentinel.
 *
 * Standalone (no heavy imports) so BOTH the periodic `pm-state-poll` producer
 * and the on-demand `hierarchy-sync` push path can reference the same value
 * without pulling each other's module graph into their bundle or unit tests.
 */

/** Sentinel `newState` stamped on a FLAG_MISSING review row (no real PM state). */
export const PM_MISSING_SENTINEL = "MISSING";

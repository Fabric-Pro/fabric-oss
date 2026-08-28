/**
 * Conversation-bundle embedding recovery (Fizzy #2228, U11).
 *
 * Re-exported from `packages/temporal/src/activities/index.ts` so the worker
 * registers it — the OPPOSITE of `lib/capture-conversation-bundle.ts`, which
 * stays out of that barrel because it is called inline from activities that are
 * already registered. This one is a Temporal activity in its own right and a
 * workflow proxies it, so it must be discoverable from the top-level barrel or
 * the schedule's every tick fails at runtime while type-checking stays green.
 */

export * from "./sweep-conversation-bundle-embeddings";

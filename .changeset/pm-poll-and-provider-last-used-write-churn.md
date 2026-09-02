---
"fabric-app": patch
---

Skip no-op story writes in the PM poll and debounce the AI provider "last used" write, cutting two top sources of database write load.

Measured on prod (14-day window, 2026-09-02): the hourly PM poll issued 238,993 UPDATEs against `user_story` (a 1,333-row table) because `reconcileStoryTerminalStatus` wrote `pmTicketTerminal`/`pmTicketTerminalStatus` unconditionally on every polled item even when the values hadn't changed, which also bumped `@updatedAt` on every linked story every hour. Separately, `updateProviderLastUsed` was the single most expensive statement in the app (54,102 calls, 3.8ms mean, 17% of app DB time) because every AI model call updated `lastUsedAt` on a 3-row table and concurrent calls serialized on the row lock.

Fix 1: `findFabricItemByExternalId` (`packages/database/prisma/queries/pending-pm-state-changes.ts`) now also returns the story's current `pmTicketTerminal`/`pmTicketTerminalStatus`. `reconcileStoryTerminalStatus` (`packages/temporal/src/activities/pm-integration/reconcile-story-terminal-status.ts`) skips the `userStory.update` when the target values already match; the two `FabricItemRef` fields are optional and fail safe (write always happens) at the hand-built call sites in `gitlab-rest-story-sync.ts` and `story-sync.ts` that don't come from `findFabricItemByExternalId`. Everything downstream (content-drift clear, auto-close/unhide, audit, return value) runs exactly as before regardless of whether the write was skipped.

Fix 2: `updateProviderLastUsed` (`packages/database/prisma/queries/ai-gateway.ts`) now does a conditional `updateMany` (id + "never touched or touched more than 60s ago") instead of an unconditional `update`, so a config is written at most once per minute and a call inside the window takes no row lock. Both callers already fire-and-forget with `.catch(() => {})` and ignore the return value.

Tests: `packages/temporal/__tests__/reconcile-story-terminal-status.test.ts` (no-op skip, flag-flip, label-only change, hand-built-ref fail-safe) and new `packages/database/__tests__/update-provider-last-used-debounce.test.ts` (debounce where-clause and cutoff, for both sources).

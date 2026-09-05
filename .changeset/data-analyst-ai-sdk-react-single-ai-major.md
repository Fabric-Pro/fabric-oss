---
"fabric-app": patch
---
Pin the data-analyst playground's @ai-sdk/react to the release built on its own ai@6, removing the unsound message-type cast (Fizzy #2409)

The data-analyst agent declared `@ai-sdk/react@^2.0.109`, which resolved to 2.0.123 and carried a private nested `ai@5.0.121`, while the agent's own `ai` dependency and its `useStreamingChat` hook resolved `ai@6.0.116`. The two majors define different `UIMessage` part unions, so `app/page.tsx` bridged `setMessages` between the two hooks with a cast through `unknown` that was only safe for the persisted text-message subset.

`@ai-sdk/react` 3.x pins `ai` to an exact patch, so the agent now pins `@ai-sdk/react@3.0.118`, the release whose dependency is exactly `ai@6.0.116` (and `@ai-sdk/provider-utils@4.0.19`, the same one `ai@6.0.116` uses), and pins `ai` to exactly `6.0.116` too, so neither side can float to a different patch and bring a second copy back; bump the two together. pnpm therefore links both hooks to the single existing `ai@6.0.116(zod@3.25.76)` snapshot, the `UIMessage` type is shared, and `setMessages` comes straight from the hook ternary with no per-branch dispatch or cast. The lockfile was hand-edited (importer, package entry, snapshot) and the now-orphaned `@ai-sdk/react@2.0.123`, `ai@5.0.121` and `@ai-sdk/gateway@2.0.27` entries pruned; `pnpm install --frozen-lockfile --lockfile-only` leaves it unchanged.

Only the agent's local Next.js playground is affected; the shipped `dist/unified-server.js` does not include it. Verified: agent `tsc --noEmit`, 32 vitest tests, prettier, and root `pnpm knip`.

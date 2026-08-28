---
"fabric-app": patch
---

A captured channel conversation whose search indexing failed is now finished automatically instead of staying unsearchable forever.

Fizzy #2228, U11. Capture (U5) deliberately makes a failed embed non-fatal: the conversation text is already durable by the time the vector write is attempted, and failing the monitor activity would re-run an analyzer whose message claims are already gone. The consequence is that the activity **completes successfully**, so Temporal has no reason to retry it — and nothing in production came back for the row afterwards. The lease model described a state nobody transitioned out of.

The worse case leaves even less behind. A worker that dies between taking the embedding lease and the vector write records nothing anywhere: `embeddedAt` is null, the parent context is still a clean `COMPLETED`, and no indexing-failure reason is attached. Anything keyed on the "Not searchable" badge would never see that row at all.

A scheduled sweep now drains that queue. `conversationBundleEmbeddingSweepWorkflow` runs every 15 minutes on the `fabric-worker` queue and calls one activity, which lists bundles with a null `embeddedAt` and no live lease and finishes them.

- **It reuses `embedConversationBundle` rather than repeating it.** That helper was exported from `capture-conversation-bundle.ts` for this caller. Reimplementing the sequence would mean reimplementing both halves of the unlink guard — the pre-write check, and the compensating delete for a point that lands in the window the unlink's filter has already swept past — and those are exactly the parts that would drift into two slightly different behaviours. The compare-and-set inside it is also what makes the sweep safe beside a live embedder: the listing only nominates, the claim decides.
- **The predicate is the exact complement of a live lease, and lives beside the claim it has to agree with.** A listing that admitted rows the claim then refuses would burn a batch slot every run forever; a narrower listing would leave rows permanently unreachable. There is an executable assertion comparing the two `where` clauses directly.
- **The tenant is read off each row, not from an ambient value.** The collection a point lands in is derived from `organizationId`, so an organization's bundle goes to that organization's collection and a personal one to the shared collection. Getting this wrong does not fail loudly — it writes a point into a collection no unlink of that channel would ever search. An organization bundle carries no `userId` of its own (the tables enforce the tenant XOR with a CHECK constraint), so the identity the embed runs under is widened from the parent context row, which is the person who linked the channel.

One bounded batch per tick, not a drain loop: a bundle whose embed fails hands its lease straight back so the next pass can retry promptly, which means an in-run loop would re-select the same failing rows for every batch instead of making progress. The activity reports whether its batch came back full, so a backlog that never drains shows up in the logs rather than staying silent.

The new activity is re-exported through the top-level `activities/index.ts` barrel — the worker registers activities from there, and a workflow proxying it from the sub-barrel type-checks either way, so an omission would only surface as a scheduled execution failing at its first tick. The inline capture helper stays out of that barrel for the opposite reason; both directions now have a guard.

`pnpm --filter @repo/temporal test:replay` has not been run for this change — it needs `TEMPORAL_*` credentials and freshly fetched dev histories.

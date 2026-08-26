---
"fabric-app": patch
---

Bound Temporal payloads under the 4 MiB gRPC frame limit so large board pulls, story-sync listings and MCP tool results degrade gracefully instead of stalling

Fizzy #1997. The binding ceiling is the gRPC max-message size (4,194,304 bytes), enforced by every Temporal frontend including Cloud; `limit.blobSize.*` dynamic config does not move it. An oversized activity return is rejected by the SDK core AFTER local completion, burns all retries, and stalls the flow with no error naming the cause — proven in production by #1741 (6,482,333-byte return rejected at exactly 4,194,304).

Changes:
- `packages/temporal/src/lib/payload-size-guard.ts` — pure measure/classify/assert helper (`assertPayloadWithinLimit` throws `PAYLOAD_TOO_LARGE` naming the boundary and serialized size).
- `packages/temporal/src/lib/payload-elision.ts` — `slimWorkItemSummaries` (progressively shortens listing descriptions, then drops raw provider fields) and `truncateMcpTextOutput` (shortens non-JSON MCP content[].text blocks; JSON-shaped listings are never cut, so programmatic parsers keep working or fail loudly instead of receiving corrupt data).
- Boundary wiring, activities only (no workflow-file changes → no replay surface): `listAllFizzyCards` + `listWorkItemsFromPM` elide past budget with a warn log; `getStoriesToSync` fails fast past the frame; chat-history and daily-brief summarizer inputs gain ≥2 MiB warnings; `executeMcpTool` bounds fresh and cached results at 512 KiB then asserts.
- An unparseable listing page now fails loudly instead of returning an empty page, which the pull workflow previously read as "board is empty" (mass-delete of synced stories).
- Elided card bodies carry a visible marker and trigger a full-card re-fetch on later passes where a get tool exists.
- Repro: `scripts/payload-limit-repro.ts` reproduces the pre-fix rejection against the local Temporal server (core log: grpc message larger than max at 4,194,304) and completes post-fix with all items.
- Tests: unit tests over guard + elision helpers.

---
"fabric-app": patch
---

Close post-ship review gaps in the Temporal payload bounding: bound every MCP tool-result exit, never corrupt JSON listings, keep elision visible

Follow-ups to the Fizzy #1997 fix (post-ship adversarial review with executed counterexamples):

- `executeMcpTool` now bounds its result at the single exported exit, so integration, Teams/GitHub/Slack OAuth and Fabric-AI tool results are covered too — previously only the generic MCP return and the Letta cache-hit path were.
- `truncateMcpTextOutput` vetoes an output entirely when any block that would be cut is JSON-shaped — including the multi-block case where an earlier prose block starves a later JSON listing below its share of the budget. Programmatic consumers can no longer receive mid-document-corrupted JSON.
- The last-resort strip pass in `slimWorkItemSummaries` leaves the elision marker instead of removing descriptions silently, so downstream re-fetch triggers still fire when bodies were dropped.
- Null elements inside provider listing arrays no longer throw during elision; they pass through untouched.
- The rest-gitlab branch of `listWorkItemsFromPM` gets the same boundary bound as the MCP path.

---
"fabric-app": patch
---

Stop Direct chat dropping whole MCP servers from the model's tool list while still showing them as connected

Reported on Fizzy #2040: four MCP servers ticked in the control deck, the request carrying all four config ids, the composer reading "4 MCP servers" — and the agent answering that it had no tool for the job. For two of the four, that answer was correct. Their tools never reached it.

`executeDirectChatActivity` caps the combined MCP payload at a schema-byte budget (added defensively for #1644). `capToolSet` spent that budget in iteration order, and `getDetailedMcpToolInfo` orders configs `createdAt asc`, so the oldest config took what it wanted and everything after it was dropped. Reproduced on staging: with Fizzy, Excalidraw, Notion and Azure DevOps selected, the model received all 19 Fizzy tools, 1 of Excalidraw's 5, and nothing at all from the other two — the exact prefix of the `createdAt` order, identical across reruns, and unchanged when the ids arrived in a different order in the request body. Asked to call an Azure DevOps tool it answered "NOT IN MY TOOL LIST"; asked with only that server selected, all 17 of its tools were there.

Three changes:

- `capToolSet` takes an optional `groupOf` and, when given one, admits tools round-robin across groups instead of in iteration order — each server contributes one tool per round, cheapest schema first within a round so a budget that runs out mid-round leaves the most servers represented. Without `groupOf` the old in-order behaviour is untouched, which is what the existing tests pin.
- `MAX_MCP_SCHEMA_BYTES` goes from 16,000 to 64,000. The original number was a conservative guess and far too tight — measured on staging at roughly 800 bytes per tool, it fit about 22 tools, so any selection past two servers lost one. The orchestrator engine runs the same provider with no byte cap at all and has been observed carrying 142 MCP tools. #1644's other half, invalid schemas, is handled by `validateMcpToolSet` and is unaffected by this number. `MAX_MCP_TOOLS` stays at 48: it is about the model choosing well from a long list rather than payload size, and with the round-robin split it now works out at a dozen tools per server for a four-server selection.
- The system prompt names the servers whose tools were left out. It previously listed only the survivors under `AVAILABLE MCP TOOLS` and asserted capability unconditionally, so the model read a truncated list as its whole capability and told the user the server was not connected. The notice sits outside the `mcpToolsEnabled` branch on purpose: if the budget ever drops every MCP tool, that branch renders nothing and the one turn where the user is most certain their servers are connected would be the one that says nothing about them.

The capping log line now records `requestedBytes` against `budgetBytes` and the affected servers, so the next adjustment to that ceiling can come from production rather than another guess.

Tests: 4 for the round-robin split (including the ungrouped starvation case as a control) and 2 for the omission summary, all mutation-checked — neutering the grouping fails two, removing the within-round sort fails a third. The prompt assembly itself is not unit-testable without extracting it from a 400-line function, and nothing here has run against a deployed worker.

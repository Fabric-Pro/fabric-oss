---
"fabric-app": patch
---

Azure DevOps sync now sends a valid work item type lookup, so state polls no longer fail one request for every work item type.

The ADO state-category lookup in `story-sync.ts` sent `{ project, type }`, but every `@azure-devops/mcp` release checked from 1.3.0 to 2.10.0 requires `workItemType`, so the server rejected each call with MCP -32602 before reaching Azure DevOps and every ADO state came back `isTerminal: false`. It now resolves through `resolveAdoTool`, which also covers the consolidated `wit_work_item { action: "get_type" }` tool from 2.9.0. The test fixtures had invented a `type` parameter that agreed with the bug; they now mirror the 2.8.0 schema and reject a missing `workItemType` the way the server does.

The upstream break behind the report was 2.9.0 consolidating the granular `wit_*` tools that most sync call sites match by name. The existing 2.8.0 pin contains it: every ADO server spawn in the staging wrapper over the last 30 days ran the pinned version, with no missing-tool or field-mapping failures. 2.10.0 adds two more breaking changes for us: it wraps every tool result in untrusted-content delimiters that the sync parsers cannot JSON.parse, and it exits at startup on node:22-slim because keytar needs libsecret-1-0. The new `ado-mcp-version-pin.test.ts` keeps the seed, enterprise seed and wrapper image on one exact pre-2.9 version so the pin cannot silently drift back to `latest`.

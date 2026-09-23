---
"fabric-app": patch
---

Fabric AI's Simple mode and the ⌘J drawer now run on the same orchestrator engine as the full page, with inline approval for write actions.

Simple mode and the drawer used to run the Direct engine, which bound a narrower tool set (no Teams, a hard 48-tool cap, no tool discovery), retried failed turns with tools switched off, and so answered the same question differently from the full page. New chats in both now run the orchestrator on its `iterative` preset (15 iterations, no task decomposition, no reflection); an existing conversation keeps the engine it was created on, and Advanced keeps its Direct / Orchestrator / Research tabs.

Orchestrator fixes that now reach every user: generic MCP and OAuth write tools are gated on runtime authority with an inline Approve, and grants bind to the conversation so approving once carries into later turns; Fabric catalog tools offered by tool search (code search, decisions, findings and more) execute instead of failing with "MCP configuration not found"; attached images reach the model and are no longer replayed every turn; the clarity check knows the attached project; tool errors no longer render as "[object Object]"; a turn that exhausts its step budget still answers from a compacted history. The orchestrator stream route checks that a supplied conversation belongs to the caller.

UI: the drawer gets the Simple/Advanced toggle (disabled while a turn streams), Expand carries the draft, files and project to the full page, the project pill can be removed, Simple mode's picker lists models only, the sidebar link carries the current project, agent "Chat" links open the unified page as an agent chat, and the unavailable-agent notice fires on either engine.

New workflow patch markers: orch-iterative-runtime-authority-v1, orch-synthesis-compacted-v1, orch-image-vision-prompt-v1, orchestrator-clarity-project-context-v1.

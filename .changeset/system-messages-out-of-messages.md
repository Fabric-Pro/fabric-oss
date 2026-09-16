---
"fabric-app": patch
---

Pass system instructions through the AI SDK's system option instead of inline system messages, which removes a per-call SDK warning and prepares the code for AI SDK 7's stricter prompt validation.

Fizzy #2527. Five call sites carried a `role: "system"` entry inside `messages` instead of the top-level `system` option: Fabric frame/file generation and first-class frame generation in `packages/temporal`, the project-context summarization fold in `packages/ai`, and RAG-context injection in `packages/api`'s `addMessageToChat`. The one deliberate exception — direct chat's Anthropic mid-conversation-system rolling-history path — now sets `allowSystemInMessages: true` explicitly instead of relying on the SDK's default-warn behavior.

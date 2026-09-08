---
"fabric-app": patch
---

The page copilot no longer answers that it has no tools, or sends you to a surface the app no longer has.

The floating copilot panel prepends its own block to the direct-chat system prompt, and that block still carried pre-merge copy: it called the panel a "lightweight copilot surface" and instructed the model to suggest opening "Fabric Loom" for anything deeper. Both statements stopped being true when the three chat surfaces became one page — "Loom" now names only an internal orchestrator workflow, and the panel binds the same MCP configs as the full page while leaving the built-in Fabric tool ids unset, which auto-enables the project tools. The model read the copy literally and told a user asking about linked Teams chats that no tools were connected and that they should open Fabric Loom, with eleven MCP servers showing in the composer beneath the answer.

The block now describes the panel by the one thing that is genuinely narrower — it runs Direct, never the orchestrator — points at the "Expand" control that actually exists, and leaves every claim about what is callable to the activity's own CAPABILITIES section, which is built from the tools bound to the turn. It is also emitted on turns with no page context, where the builder previously returned nothing at all and left the activity default's "You are Fabric Loom" as the model's self-description.

---
"fabric-app": patch
---

Every AI feature in the application now runs on Vercel AI SDK 7.

The move had to happen in one step rather than package by package: every AI feature imports the SDK through one shared module, and that module must resolve a single copy of it, so chat, the orchestrator, research, document generation, the agents and the MCP tooling all move together. The installed set is `ai` 7.0.101, `@ai-sdk/openai` 4.0.66, `@ai-sdk/anthropic` 4.0.53, `@ai-sdk/groq` 4.0.41, `@ai-sdk/cerebras` 3.0.48, `@ai-sdk/deepseek` 3.0.44, `@ai-sdk/mcp` 2.0.49 and `@ai-sdk/react` 4.0.104.

Four changes are visible in the product:

- A chat turn that takes several steps now reports the token usage for the whole turn. It previously reported only the last step, so multi-step turns under-reported what they cost.
- Research now returns the findings it gathers from the web. They were being read from a field the SDK renamed, so every finding was discarded and the research ran with none.
- Tool call arguments now reach live progress updates and the record used to learn from past runs. They were arriving empty.
- An OAuth-connected MCP server that answers with an HTTP redirect now reports that redirect clearly instead of a generic connection failure. Configure such a server with the URL it redirects to.

---
"@repo/agent-core": patch
---

Enable automatic prompt caching for direct Anthropic LangChain calls while preserving caller overrides and the existing cache-disable switch.

Normalize native Anthropic cache-token usage before billing so cached input is not counted twice (Fizzy #2426).

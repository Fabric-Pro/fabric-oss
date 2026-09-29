---
"fabric-app": patch
---

Claude Sonnet 5.5 is now available in AI model settings through Anthropic, Vercel AI Gateway, OpenRouter, AWS Bedrock and Databricks.

Sonnet 5.5 rejects a forced `tool_choice`, so it joins Opus 5.5 in the shared `anthropicModelRejectsForcedToolChoice` predicate and frame, slideshow and orchestrator tool calls fall back to `auto` on it. It is already covered by the adaptive-only predicate, so it gets adaptive thinking and no sampling parameters.

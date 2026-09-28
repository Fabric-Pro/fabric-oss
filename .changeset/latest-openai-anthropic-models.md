---
"fabric-app": patch
---

GPT-6 Astra, Sol and Luna and Claude Opus 5 and 5.5 are now available in AI model settings, older Claude Opus 4.5–4.7 and Sonnet 4.5 are retired in favour of Opus 4.8 and Sonnet 4.6, and deep-reasoning mode no longer fails on Claude Sonnet 5 and Opus 4.7/4.8.

The retired models are deactivated rather than deleted: the catalog seed now marks them deprecated with a replacement, so they leave the model pickers while saved user and organization selections resolve to the replacement instead of being cascaded away. Request shaping is now keyed on shared model-property predicates in `@repo/agent-types`. Adaptive-only Claude models (Opus 4.7/4.8 and the 5.x generation) get `thinking: { type: "adaptive" }` instead of a fixed `budget_tokens`, and no sampling parameters on the LangChain paths. GPT-6 gets the same reasoning-model handling as GPT-5. Frame and slideshow output no longer forces a tool call on Claude Opus 5.5, which rejects forced `tool_choice`. Claude Sonnet 5 pricing is corrected to $2 / $10 per million tokens, and Claude Sonnet 4.6 gains an AWS Bedrock mapping so Bedrock selections of Sonnet 4.5 can move to it.

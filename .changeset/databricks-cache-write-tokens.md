---
"fabric-app": patch
---

Completed Databricks-served Claude calls through the AI SDK now record prompt-cache write tokens, so cost estimates apply the cache-write rate instead of pricing those tokens as ordinary input.

Fizzy #2522. Databricks reports Anthropic-style `cache_creation_input_tokens` on its OpenAI-compatible chat-completions responses, but until `@ai-sdk/openai@3.0.84` there was no OpenAI-shaped field for the SDK's closed usage schema to carry it through, so every `@ai-sdk/openai`-path call logged a zero cache-write count. The compat shim now aliases the field onto `prompt_tokens_details.cache_write_tokens`, which the bumped SDK (`^3.0.107`) reads into `inputTokens.cacheWrite`, and `estimateAiUsageCostUsd` applies the 1.25x cache-write multiplier accordingly. The LangChain agent path already read the raw field directly and is unaffected.

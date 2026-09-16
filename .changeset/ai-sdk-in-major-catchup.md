---
"fabric-app": patch
---

The Vercel AI SDK and every `@ai-sdk/*` provider are now on their current in-major releases, so provider schema additions such as OpenAI cache-write usage fields reach the app without a month-long lag.

Fizzy #2523. `ai` moves from 6.0.116 to 6.0.283 in every workspace package, and the providers in `packages/ai` move to their `ai-v6` dist-tag tips (`@ai-sdk/openai` 3.0.112, `@ai-sdk/anthropic` 3.0.118, `@ai-sdk/groq` 3.0.66, `@ai-sdk/cerebras` 2.0.81, `@ai-sdk/deepseek` 2.0.64), which collapses the previous `@ai-sdk/provider` 3.0.8 / 3.0.15 split onto 3.0.16. `packages/fabric-ai` and `agents/langchain/data-analyst` leave the 1.x and 2.x provider lines for 3.x, so their transcription and chat models implement the V3 model interfaces that `ai` 6 expects; the `as any` bridge in `fabric-ai`'s transcription path is gone. `apps/web`'s `@ai-sdk/react` moves to 3.0.286, which drops the second `ai` 6.0.1 copy it had been carrying. `agents/langchain/weave-planners` drops its unused `@ai-sdk/openai` and `ai` dependencies instead of bumping them.

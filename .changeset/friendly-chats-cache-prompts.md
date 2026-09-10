---
"@repo/ai": patch
"@repo/temporal": patch
"@repo/web": patch
---

Cache stable system instructions and repeatable history for direct chat and Sidekick requests.

Upgrade the Anthropic adapter and cache stable system instructions across eligible Claude models. Enable rolling-history caching only for documented mid-conversation-system model families, keeping changing caller, project, retrieval, memory, skill, form, date, and prompt-enhancement context outside reusable checkpoints while preserving legacy request shapes for other models.

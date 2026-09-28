---
"fabric-app": patch
---

The AI assistant now introduces itself as Advisor on both its Direct and Orchestrator engines, and agent registration, the MCP chat dialog and the agent template gallery no longer use the retired "Fabric Loom" and "Nexus" names.

Fizzy #2571. The Direct engine's system prompt opened with "You are Fabric Loom", and the Orchestrator had no identity line at all, so asked what it was it improvised a name from chat history and memory ("a 'Loom' workspace environment"). Both engines now start from one shared identity constant; an orchestrator run whose caller supplies its own persona (the Fabric Agent drawer, @template instructions, agent instances) keeps it unchanged. Surface literals, Temporal patch ids and template slugs are unchanged. The orchestrator's featured card on the AI Agents page was renamed with the rest and then restored to "Fabric Loom" at Product's request, so production never sees it change.

---
"fabric-app": patch
---

Recover missed Research and Orchestrator chat output when reconnecting to existing workflows, using retained text and tool events with scoped resume cursors to prevent duplicate output. Recovery preserves partial replies, respects cancellation and current access, and never resubmits the original message or re-executes tools.

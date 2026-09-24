---
"fabric-app": patch
---

Fabric AI can read the project's live roadmap, flags cut-off answers with a Continue button, and keeps long chats, images and diagrams working.

Follow-up to the unified chat engine switch. Both chat engines gain read-only tools for the attached project's features; the default model has one source (Sonnet 5) and seeded agent templates follow the tenant's task default. The Direct engine (Advanced → Direct, agent chats, older threads) no longer mixes conversations when switching from History, no longer re-runs a whole turn when a tool is slow, says honestly when tools failed, stops duplicating answers on reload, trims long histories instead of failing, and shows provider errors and limits. Answers cut off at the output or step limit are flagged in both engines; history is fitted to the model's context window; pasted images are compressed and bounded server-side. Diagrams render inline as mermaid, code search can target one repository, streaming no longer re-renders every message, and several History and drawer glitches are fixed.

New workflow patch markers: orch-project-feature-tools-v1, direct-chat-honest-no-tools-retry-v1, orch-truncation-signal-v1, orch-diagram-inline-mermaid-v1.

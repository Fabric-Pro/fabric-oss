---
"fabric-app": patch
---

Add an AI assistant rail to the publishing Topic Item Page, able to rewrite the planning analysis for review

Fizzy #1851, finding #15 — the last of the owner's findings. Every AI affordance
in this suite was a single Generate button, so there was no way to tell the
assistant to do something a little bit different.

Reuses the Feature Maturation machinery rather than resembling it: the same
`project_document_generator` agent, the same `useCoAgent` seeding of
`state.document` with the document under discussion, and the same single
frontend action (`confirm_changes`) rendered as an accept/reject card. Writing a
bespoke "propose a rewrite" action instead would have put a second, unprompted
tool beside the agent's own blessed `write_document_local` and left the model to
pick — the failure being a chat that says it rewrote the analysis while nothing
reaches the page.

One deliberate divergence from FMv2: accepting does not save. FMv2 autosaves;
this suite does not, because #1929's worst defect was an autosave racing an
in-flight agent and overwriting the server with pre-answer text, and a revision
here is defined as "what a person saved". So accepting seeds the Planning &
Analysis editor and the existing Save stays the only writer.

Known gap, scoped: the conversation is ephemeral. The document editor persists
its thread through a persistence hook, a hydration provider and an attachment
registry; none of that is wired here, so leaving the page ends the conversation.

- `TopicAssistant.tsx` (new) — provider, error boundary, co-agent, readable
  context and the confirm card. Reached through `next/dynamic`: a static import
  would put CopilotKit's stylesheet, and the transitive katex `.css` jsdom
  cannot load, into the import graph of the `publishing-suite` barrel and break
  three Inbox suites over a component they never render.
- `PlanningAnalysisTab.tsx` — takes the accepted rewrite as an editor seed,
  guarded on the proposal's own text rather than on the effect's dependency
  list, so a caller that rebuilds its callback per render cannot re-seed the
  editor and destroy what was typed since the accept.

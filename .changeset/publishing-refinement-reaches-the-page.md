---
"fabric-app": patch
---

Refining a Publishing Suite draft now shows the proposal as a reviewable diff instead of doing nothing visible

The server half of "a refinement is a proposal, not a candidate" shipped without
its UI, so clicking Refine still ran the old generation path: it minted a
candidate, raised the version count, left the working copy untouched and showed
no review.

Two gaps caused it. The first was that the UI was never wired. The second was
invisible to both halves — `listTopicDrafts` declares an oRPC output schema that
did not list the refinement, and zod strips what an output schema omits, so the
proposal never left the server. No error and no trace; the feature simply
rendered nothing.

Wiring it surfaced two more failures that would each have looked like the
feature being broken: a pending flag that cleared on an event a refinement never
fires, so all seven panels would have spun forever; and nothing polling a
running refinement, so a finished proposal appeared only after a manual refresh.

Accepting takes the reviewed merge rather than only the stored proposal, so
per-change accept and reject work — the client may not supply the text a
generation runs on, but the body a person reviewed and saved is the case the
draft save path already serves. A blank merge falls back to the proposal, and
the revision history records what was actually accepted.

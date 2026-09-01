# ADR-009: A Scheduled AI Document Refresh Proposes by Default; Applying Is Opt-In

- **Status**: Accepted
- **Date**: 2026-07-13
- **Deciders**: Engineering team
- **Audience**: Engineers working on Living Documents, the document editor, or any feature that puts an AI on a schedule
- **Owner**: Fabric platform

## Context

The Living Documents feature request was: enroll a project document in a cadence, and have the AI keep it current. Its narrative was explicit on one point, and the PM had marked it Resolved:

> **FR11 / Key Decision (PM):** *The AI refresh agent commits the updated version without requiring human approval.*

The implementation reuses the engine behind the editor's **"Update using context"** button (`packages/temporal/src/lib/update-with-context-core.ts`). Reusing it looked like adding a trigger to an existing capability.

It is not. That engine is a **proposal generator**. `updateDocumentWithContextProcedure` takes `preview: z.boolean().default(true)`, returns a candidate plus a diff, and requires a separate accept call. Enumerate its safety properties honestly and there is exactly one:

> **A person reads the diff before anything is saved.**

There is no output-size validation, no magnitude guard, no escaping of the attacker-influenceable context it interpolates into the prompt, and its `needsHumanResolution` flag was advisory — nothing downstream had to honor it. Every one of those omissions was *reasonable*, because a human was the last gate.

Code review (six reviewers; security, adversarial, and correctness converged on this independently) established what removing that gate actually produces:

- **A write primitive into the customer's specifications, reachable from Slack.** Context items are built from meeting transcripts and live Slack/Teams messages. They were interpolated raw into a pseudo-XML fence, so a message could break out and forge an `Approved ADR` — a source the system prompt ranks above all others and instructs the model to *remove contradicting document content* around.
- **No guard on the magnitude of the change.** The only commit gate was an LLM's self-reported `hasRelevantContext`. A truncated generation that returns a plausible, complete-looking, 40%-shorter document passes it and commits.
- **A silent failure mode.** Version history would have shown the AI's rewrite attributed to the next human who touched the document (see ADR consequence 4 below), no notification was sent by default, and the flag was not a working kill switch.

The question this ADR answers is therefore not "should the AI write?" but: **was FR11 a considered acceptance of an unreviewed LLM write, or a statement about friction?**

## Decision

**A scheduled refresh proposes. Applying it is a per-document opt-in, off by default.**

- `DocumentAutoRefreshSettings.autoApply` — `Boolean @default(false)`.
- With it off (the default), a refresh stores its result (`pendingContent`, `pendingSummary`, `pendingBaselineVersion`) and notifies. A human accepts or discards it.
- With it on, the refresh writes directly — **the behavior FR11 asked for, preserved as a capability rather than a default.**
- Accepting a proposal re-runs the same optimistic-concurrency check it was generated under, so a proposal overtaken by a human edit is refused rather than applied blind.

The distinction was surfaced to the decision-maker rather than resolved unilaterally in either direction. Silently reversing an explicit PM decision and silently implementing a dangerous one are the same class of error.

## Consequences

1. **FR11's capability survives; its default does not.** A team that genuinely wants unattended commits enables `autoApply` per document, deliberately. Nobody gets it by accident.

2. **The unattended path is guarded, for when `autoApply` is on.** It refuses the model's own `needsHumanResolution` flag (a successful prompt injection looks exactly like this), refuses a rewrite that would delete most of the document, escapes context before it enters the prompt, re-reads the kill switch immediately before writing, and commits under a real compare-and-set so a human who saves *during* the multi-minute model call wins.

3. **The sweep gets its own Temporal task queue (`document-refresh`).** It previously shared `project-documents`, which has five activity slots and serves a human clicking "Update using context" and waiting. An unattended sweep that goes wide — every enrolled document is due at once the first time the flag is switched on — must not be able to starve the foreground path.

4. **Version authorship had to be fixed first.** A `DocumentVersion` row holds the content that was live at that version but was labelled with the author of the change that *superseded* it. Harmless for as long as every writer was a person; the instant an AI writes, the ledger inverts — the row holding a human's text gets the agent's name, and the next human edit snapshots the *agent's* rewrite under that human's name. For a feature whose entire safety story is "it is all in version history," that was the wrong bug to ship.

5. **A retrieval outage is now a failure, not a silence.** Retrieval resolves empty when the embedding provider is down. For a human that degrades to "no relevant context." For an unattended job it read as *"we looked and nothing had changed"* — advancing the cadence clock and silencing the document for a fortnight, across every tenant, with no error anywhere.

6. **The generalizable rule** (captured in `docs/solutions/architecture-patterns/scheduling-an-interactive-ai-engine-deletes-its-safety-model.md`): before scheduling an interactive AI flow, write down what the human's presence was load-bearing *for*. Every item on that list is a guard you now owe the system. A long list means it is not "the same feature, unattended" — it is a different feature.

## Alternatives Considered

- **Implement FR11 as written and add compensating guards.** Rejected as the default. The guards are real and shipped, but they mitigate; they do not remove the fact that an LLM writes to a customer's specification with nobody looking. Reviewers found guards *after* the fact in three independent passes — the next one is not guaranteed to be found.
- **Drop direct commit entirely.** Rejected. The PM asked for it, and there are legitimate low-stakes uses. Removing the capability outright would substitute one unilateral reversal for another.

## References

- The durable lesson: [`../solutions/architecture-patterns/scheduling-an-interactive-ai-engine-deletes-its-safety-model.md`](../solutions/architecture-patterns/scheduling-an-interactive-ai-engine-deletes-its-safety-model.md)
- Prior art for the compare-and-set and terminal-state discipline: [`../solutions/architecture-patterns/cancelling-temporal-backed-jobs.md`](../solutions/architecture-patterns/cancelling-temporal-backed-jobs.md)

# Proposal Artifact

How one generation request produces a client-ready Proposal, its visuals and a separate Internal Analysis, and how to roll the feature out.

- **Audience**: Developers extending Proposal generation; operators enabling the feature for an organization
- **Owner**: Documents

## What it is

With the `PROPOSAL_ARTIFACT` rollout gate on for an organization, generating or regenerating a Proposal runs one coordinated job instead of the Draft followed by a Glossy edition:

1. the **Main Document** is written from a client-only prompt and its finished sections appear on the page while the agent is still writing;
2. visuals are added to the Main Document in the same job;
3. after the Main Document is saved, an **Internal Analysis** reviews it against the same source context and records findings that only members of the organization can read.

The Main Document is the client artifact: it never carries review notes, citations, a source index or readiness status, and the existing PDF and DOCX downloads export it alone, with its Markdown tables drawn as tables. Business Case and every other document type keep their current flow, and a Glossy edition that already exists for a Proposal stays reachable while `GLOSSY_EDITION` is on. The terms are defined in [CONCEPTS.md](../../CONCEPTS.md#proposal-artifact).

## Generation

The decision is made once per run, inside `documentGenerationChildWorkflow`, behind `patched("proposal-artifact-v1")`, so every path that generates a Proposal (editor, documents list, chat, create dialog, setup wizard, uploads) takes the same branch. The plan activity reads the gate for the project's owning organization first and returns nothing when it is off, so organizations without the gate never depend on the new prompt actions.

- **Prompt.** Main is rendered from the prompt bound to the `proposal_client_main` action, at the bound version, on every retry. The editor's prompt choice and `DEFAULT_PROMPTS` are not used. When nothing is bound, generation is refused with a message naming the action: early at dispatch and in the setup wizard, and authoritatively in the workflow before the agent is called. A personal binding on this action is refused, so no individual prompt can steer the client document.
- **Live sections.** The activity reads the agent's cumulative previews, keeps the text up to the last completed H2 or H3 section, and writes it to `ProjectDocument.liveContent` at most every 1.5 seconds, followed by a `document_change` nudge carrying ids only. `content` is untouched until the final save. Every write is owned by the run's `liveRunId`, so a superseded run can write neither previews nor the final document.
- **Visuals.** Before the save, timeline, flow and org-chart visuals become Mermaid fences and comparisons become tables, inserted after the first block of their section. Colours come from the document's Style and the project's recipient brand. Sections that already hold a Mermaid diagram are skipped. The step is bounded and fails open: the Main Document is saved without visuals rather than lost.
- **Analysis.** After save, version and embed, a non-fatal block records an analysis run and starts `proposalAnalysisWorkflow` with an abandon close policy. The run stores the saved Main Document, its hash and a bounded copy of the generation's source context. Analysis is not run for generations a project guest started, and an unbound `proposal_internal_analysis` action records a failed run without affecting Main.

## Internal Analysis

Findings carry a severity (Blocking, Important, Informational) and a type (Scope, Commercial, Assumption, Risk, Gap, Source Validation, Architecture, Branding, Opportunity). The library prompt owns the instructions; the code owns the output contract.

Analysis rows live in `ProjectDocumentAnalysis` and `ProjectDocumentFinding`, organization-only tables (`ORG_ONLY_TABLES`, `org_only` RLS). They are never part of `ProjectDocument.content`, a version, an embedding, an MCP or v1 read, or an export. `projects.proposalArtifact.getAnalysis` returns the newest run to organization members only: a project guest receives FORBIDDEN with `ORGANIZATION_MEMBERSHIP_REQUIRED`. A run is labelled stale when the Main Document changed since it was analysed, and timed out when it has made no progress for 20 minutes.

## Document page

For organization members, a Proposal in artifact mode shows three tabs:

- **Main Document**: the live sections while the run is queued or generating, then the editor, with larger type and a readable line length.
- **Internal Analysis**: the newest run's state and findings.
- **Style**: style direction, primary and accent colours, and the project's recipient brand, saved per document and applied to the next generation.

Project guests see the Main Document only, without the name of the library prompt or a prompt choice: their runs use the bound prompt too.

## Decisions and limits

- **No `stat` visuals.** Big-number callouts have no Markdown or Mermaid form in the Main Document, so the visuals step does not produce them.
- **Free-form instructions stay.** Instructions typed when generating are appended to the Main prompt as before; the Main prompt is what keeps the result client-facing.
- **No model check before guests read Main.** The separation is structural: Analysis runs only after Main is saved, and its output lives only in organization-only tables, so the Main generation never sees a finding.
- **Analysis sees visuals as Mermaid source**, not as rendered images, so it cannot judge their appearance.
- **Analysis output is findings only.** An analysis prompt that asks for a free-form report (an overall assessment, a source index) is reduced to the findings the output contract holds.
- **Operational choices.** Analysis runs on the `project-documents` task queue. Style changes are not audit events: they are presentation settings, not security-relevant mutations.

## Rolling it out

1. Create the client-only Main prompt and the analysis prompt in the organization's prompt library and bind them to the **Client proposal (Main)** and **Proposal internal analysis** actions. The seed creates synthetic defaults for fresh environments only; existing environments need the binding by hand. The Main prompt should structure its sections with H2 or H3 headings, which is what live sections cut on.
2. Enable `PROPOSAL_ARTIFACT` for the organization on its per-organization feature flag page, not the global panel.
3. Keep `GLOSSY_EDITION` on wherever existing Glossy editions must stay viewable.

Visuals and Analysis resolve their model like generation does. An organization without a configured AI provider gets Proposals without visuals and an analysis that reports the provider as not configured.

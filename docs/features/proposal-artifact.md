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

Analysis rows live in `ProjectDocumentAnalysis` and `ProjectDocumentFinding`, organization-only tables (`ORG_ONLY_TABLES`, `org_only` RLS). They are never part of `ProjectDocument.content`, a version, an embedding, an MCP or v1 read, or an export. `projects.proposalArtifact.getAnalysis` returns, to organization members only, the newest complete run whose analysed text matches the current text, else the newest complete run labelled stale, together with the status of any newer run; a newer run that is pending, running or failed never hides a complete one. A project guest receives FORBIDDEN with `ORGANIZATION_MEMBERSHIP_REQUIRED`. Staleness compares a prose hash (see Review), so an editor save or a recolour that leaves the text alone does not mark a run stale. A run is timed out when it has made no progress for 20 minutes.

## Review

Fizzy #2946 makes the analysis something members act on.

- **Sections and prose hashes.** `@repo/utils/proposal-artifact/section-hash` parses the Main Document once with remark and splits it at every heading. A section's key is its heading path (numbering and the document title left out) plus an occurrence index; its prose hash covers its own text after parsing, with separators for blocks, list items and table cells, and without Mermaid fences, visual markers, visual slots or link and image addresses. Keys and hashes carry a `p1:` version prefix, and the same golden fixture is asserted in Node, jsdom and the worker, plus a round trip through the editor's load and save.
- **Findings.** The analysis lists the sections by number and asks for the section index, a short subject and the source numbers each finding relies on. A finding's stable key is its type, section key and normalised subject, never its wording; findings that share a key in one run fold into the first, which keeps the most severe of their severities and the others' titles, details and recommendations.
- **Evidence.** On the Proposal branch, retrieval also returns a manifest of what each source string was (project context, company source, project summary, other). The run keeps the entries for the sources the analysis actually read, numbered as the `### Source N` blocks the model saw. Evidence is read from each source's current row, never from a copy kept with the run, so text removed from a source does not resurface: project contexts and company sources show their current title and the opening of their current text, LINK and meeting transcript contexts also link to their pages, and the project summary and other sources show their label only. A source that no longer exists in the project or organization shows as removed, with nothing else; a run recorded without a manifest shows no evidence rather than calling its sources removed. No source address is ever returned.
- **States.** A finding is Unaddressed, Confirmed, Responded or Needs Review. Responses (`ProjectDocumentFindingResponse`, organization-only like the analysis tables) belong to the document and the stable key, not to a run. Needs Review is derived at read time, never stored: the section's prose hash differs from the one the answer was given against ("section changed"), the section is gone ("section not found"), or a later run raised the key again ("raised again"). Answers whose key the shown run does not raise are listed as no longer raised, with their own state. `finding-state.ts` in `@repo/utils` is the one derivation the page and the settled feed both use.
- **Answering.** `respondToFinding`, `clearFindingResponse` and `rerunAnalysis` need `DOCUMENT_UPDATE` and organization membership; commenters and viewers read only, and guests are refused. Writes use a compare-and-swap on the answer's id and version (so an answer cleared and given again never matches a stale tab's copy) and return a stale outcome, not an error, when another member saved first or the run changed. Audit actions `project.document_analysis.responded`, `cleared` and `rerun_started` carry keys and kinds, never answer text, and the error-capture middleware skips `respondToFinding` so a refused call cannot copy an answer into the audit log either.
- **Re-run.** A re-run analyses the current text against the stored sources of the generation that produced it, even when that generation's own analysis failed (or else the newest generation run with sources), through the existing `proposalAnalysisWorkflow` under a per-run workflow id. It is refused while the document is generating or another run is in progress; a run with no update for 20 minutes counts as finished. Re-runs are limited per organization. Regenerating is how new sources are picked up.
- **Settled decisions.** `buildSettledDecisionsBlock` (`@repo/temporal/proposal-artifact-settled-decisions`) turns the document's confirmed and answered findings into a fenced block for the Main generation and the analysis. It keeps only answers that are not in Needs Review and whose author is still an organization member with edit rights, neutralises and caps each one, and returns nothing for a guest, a system start, a missing organization or any error in its checks. It is joined to the prompt, never assigned over supplied context. Before writing a live preview and before saving a Main Document that carried the block, the generation refuses (`RESPONSE_ECHOED`, not retried) when the text repeats a run of 12 or more words from an answer or a finding title that the sources, the project information in the prompt and the previous Main do not also contain. The refusal message every reader sees names no answer; the worker log records the stable keys of the answers involved, so the answer to reword or clear can be found. Shorter answers are not checked: a short factual answer is expected to shape Main.

## Document page

For organization members, a Proposal in artifact mode shows three tabs:

- **Main Document**: the live sections while the run is queued or generating, then the editor, both on the Proposal theme.
- **Internal Analysis**: the run describing the current text, each finding's state and evidence, Confirm, Answer and Clear for members with edit rights, answers no longer raised, and Re-run. The tab's badge counts Blocking findings still needing a decision.
- **Style**: style direction, primary and accent colours, and the project's recipient brand, saved per document and applied to the next generation.

Project guests see the Main Document only, on the same theme, without the name of the library prompt or a prompt choice: their runs use the bound prompt too.

## Proposal theme

A client-document Proposal, one whose owning organization has the `PROPOSAL_ARTIFACT` gate on, is shown on one theme for organization members and project guests alike, so the page a reader edits looks like the document the client receives. The same stylesheet carries a print layer: US Letter pages, running header and footer, the cover and landscape pages. The diff viewer, the other editors and every other document type keep the app's own styling.

- **One predicate.** Whether a document is a client-document Proposal is decided by `isProposalClientDocument` in `@repo/database` (gate on for the project's owning organization, and type Proposal); `projects.proposalArtifact.getThemeTokens` asks it, and the page wears the theme only when that procedure answers. `isProposalInternalReader` adds membership of that organization, the rule the tabs, Analysis and Style follow; their procedures ask it through the member-only loader `loadProposalArtifactDocument`, which keeps its refusals: FORBIDDEN with `ORGANIZATION_MEMBERSHIP_REQUIRED` for a guest, BAD_REQUEST for a document that is not a Proposal. The page itself reads the rollout flag and the document type only to wear the neutral theme while the server's answer is on its way.
- **Tokens.** The theme reads only brand tokens (`@repo/utils/proposal-artifact/theme-tokens`): the proposer's name, logo, primary and accent colours, paper, ink, fonts and hero image, and the recipient's name, logo and colours, each with the source it came from. Today the document's Style supplies the primary and accents (a person's choice), the organization's Brand kit supplies accents when the Style has none, the organization's name and its uploaded logo name the proposer, and the project's recipient brand names the recipient. Everything else is the neutral style: Inter, near-black ink on white paper, one slate accent. A document without brand values shows no logo and the neutral palette.
- **Contrast.** Every colour the theme paints as text, or behind text, is checked against the paper it sits on. A colour that fails is painted with the neutral fallback, and the token keeps its value and source, so a pale brand primary never makes headings unreadable.
- **Paper in both colour modes.** The document is painted on the theme's own light paper in light and dark mode, as it will print. Editor controls inside the paper read the app's colour tokens remapped onto the paper.
- **Guests.** `projects.proposalArtifact.getThemeTokens` gives the page its tokens. It requires document read access, the document to belong to the project, project access and the client-document predicate, and no membership; anything else answers NOT_FOUND. It returns tokens with short-lived signed logo reads and never the Style's direction or the Brand kit's guidance. Logos are taken only from the keys their uploads write: `{organizationId}.png` for the organization, the project's recipient brand prefix for the recipient.

### Markdown the theme styles

For the owner of the library's Main prompt: the theme gives these Markdown forms their look, on the page and in print.

| Markdown | Shown as |
|---|---|
| The paragraph right after the document's `#` title | Lead paragraph |
| `##` headings | Section headings; in print, a section opener band with a "Section N" eyebrow |
| `> ` blockquote, ideally opening with a bold sentence | Callout: left rule, tinted background |
| A table with a header row | Data table: dark header row, small uppercase labels, zebra rows |
| A `stat-tiles` fence | Stat tiles (below) |
| A Mermaid diagram or an image, with its caption | Figure with caption |

A stat-tiles block is a fenced block with the language `stat-tiles` and one to four lines of `label: value`, the value at most 24 characters and the label at most 80:

````markdown
```stat-tiles
Faster onboarding: 40%
Pilot sites: 3
Annual savings: $1.2M
```
````

A generated block may open with one `%% fabric-visual: <id>` line, the visual's id, which is not a tile. Nothing is evaluated: no HTML, YAML or JSON. A block that breaks the rule is shown as its source with the reason in the editor and as a plain code block elsewhere. In a client-document Proposal the single-user editor and the live sections draw the tiles; the shared (collaborative) editor, every other document, the other editors and the diff viewer show the fence as code, and the existing PDF and DOCX downloads print its lines as text. The shared editor waits because a collaborator's browser on an older release would not know the tiles and would drop the block from the shared document.

## Decisions and limits

- **Stat tiles are not generated yet.** The visuals step still does not produce them; a stat-tiles block appears only where a person or the Main prompt writes one.
- **Free-form instructions stay.** Instructions typed when generating are appended to the Main prompt as before; the Main prompt is what keeps the result client-facing.
- **No model check before guests read Main.** The separation is structural: Analysis runs only after Main is saved, and its output lives only in organization-only tables. The Main generation never sees a finding's detail or evidence; it sees members' answers and the titles they answer, as settled decisions, guarded by the echo check above.
- **Raised again means Needs Review**, even when the section's text has not changed, and such an answer stops feeding generations until a member confirms it again. A re-run can therefore move answers to Needs Review when the model repeats a finding.
- **Old runs cannot be answered.** Findings recorded before Fizzy #2946 have no stable key; the page offers a re-run instead.
- **Analysis sees visuals as Mermaid source**, not as rendered images, so it cannot judge their appearance.
- **Analysis output is findings only.** An analysis prompt that asks for a free-form report (an overall assessment, a source index) is reduced to the findings the output contract holds.
- **Operational choices.** Analysis runs on the `project-documents` task queue. Style changes are not audit events: they are presentation settings, not security-relevant mutations.

## Rolling it out

1. Create the client-only Main prompt and the analysis prompt in the organization's prompt library and bind them to the **Client proposal (Main)** and **Proposal internal analysis** actions. The seed creates synthetic defaults for fresh environments only; existing environments need the binding by hand. The Main prompt should structure its sections with H2 or H3 headings, which is what live sections cut on.
2. Enable `PROPOSAL_ARTIFACT` for the organization on its per-organization feature flag page, not the global panel.
3. Keep `GLOSSY_EDITION` on wherever existing Glossy editions must stay viewable.

The review release adds a migration and changes the analysis activity, so it deploys in the usual order: migration, then the Temporal worker, then the web. A re-run started by a newer web on an older worker would analyse without its sources and record findings that cannot be answered.

Visuals and Analysis resolve their model like generation does. An organization without a configured AI provider gets Proposals without visuals and an analysis that reports the provider as not configured.

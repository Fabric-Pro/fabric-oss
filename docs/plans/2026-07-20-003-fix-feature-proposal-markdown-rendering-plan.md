---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
date: 2026-07-20
type: fix
status: implementation-ready
---

# Feature Proposal Markdown Rendering - Plan

- **Audience**: frontend engineers working on the feature-proposal / backlog-change review surfaces
- **Owner**: web app team

**Product Contract preservation:** changed — Scope-In #2 (maturation panels) kept
in scope per user decision; clarified that those panels render meeting-digest /
thread content, not proposal `description`/`acceptanceCriteria`. No product intent
altered; success criteria unchanged.

---

## Goal Capsule

- **Objective:** Feature-proposal description and acceptance-criteria text — currently shown as
  raw Markdown (`**bold**`, `## heading`, `| col |`, `- item`) — renders as formatted output
  across the proposal-review surfaces, using one shared, reusable Markdown primitive.
- **Product authority:** Product team (requested and scoped this fix). Original reporter:
  internal report (Teams, 2026-07-09). Product decision on always-on vs autodetect resolved to
  **always-on**.
- **Open blockers:** None. Root cause confirmed in code and reproduced on staging 2026-07-20.

---

## Problem Frame

Bug report (BUG, Medium, P2): the Feature Proposal review modal and its sibling surfaces show
literal Markdown syntax instead of rendered formatting. **Reproduced on staging** 2026-07-20:
the "New: …" detail dialog renders `**Steps to Reproduce**`, `**Expected Behavior**`,
`**Actual Behavior**` as plain text.

**Root cause (confirmed — coverage gap, not a regression):** the review modal
[`BacklogChangeDetailDialog.tsx`](apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx)
renders `description` and `acceptanceCriteria` through its internal `DetailDiffSection`, which
drops the raw string into a plain `<p className="text-sm whitespace-pre-wrap break-words">`
([:873](apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx#L873),
[:898-908](apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx#L898-L908)).
No Markdown renderer is applied. The June markdown work (#2079/#2080/#2085/#2086) was all
document-editor structure repair and PM-sync round-tripping — none touched this render path.

The whole proposal cluster is plain text; only Atlas node panel currently renders Markdown. The
library is already present: `react-markdown@^10` + `remark-gfm@^4` in
[`apps/web/package.json`](apps/web/package.json). There is **no** shared `<Markdown>` component
today — 8+ surfaces inline `ReactMarkdown` with `remarkPlugins={[remarkGfm]}` under a
`prose prose-sm dark:prose-invert max-w-none` wrapper (canonical example:
[`AtlasNodePanel.tsx:834-846`](apps/web/modules/saas/projects/components/atlas/AtlasNodePanel.tsx#L834-L846)).

---

## Product Contract

### Problem & Value

Users reviewing feature proposals — especially AI-generated ones, which lean heavily on Markdown
— see raw syntax instead of readable, structured content. Tables and headings are the worst hit.
This degrades the review experience and erodes trust in AI output quality. Value: proposals
become readable at a glance, and the fix establishes one reusable Markdown primitive the codebase
currently lacks.

### Scope — In

1. **Shared Markdown primitive** in `apps/web/modules/ui/components/` (none exists today), wrapping
   `react-markdown` + `remark-gfm` in the house `prose prose-sm dark:prose-invert max-w-none`
   convention. Gives the 8+ inline call sites a canonical component to converge on.
2. **Lightweight `stripMarkdown` helper** for clamped previews — regex-based, no new dependency.
3. **Render Markdown in the review modal** (`BacklogChangeDetailDialog`) — `description` +
   `acceptanceCriteria`, both before/after panes.
4. **Strip Markdown in clamped previews** — proposal cards (`BacklogChangeProposal`) and pending
   inbox summaries (`PendingBacklogProposalsInbox`).
5. **Render Markdown in maturation panels** (`SummaryQuestionsPanel`, `DecisionLogPanel`) — the
   full (non-clamped) meeting-digest / thread-content `<p whitespace-pre-wrap>` sites. Same bug
   class; mechanically identical to the modal's full-view swap, with no diff-chrome complication.

### Scope — Deferred to Follow-Up Work

- **Migrating the 8+ existing inline `ReactMarkdown` call sites** (Atlas, daily-brief,
  meeting-digest, `UrlSourcePageView`, `MeetingTranscriptPageView`, etc.) onto the new primitive.
  The primitive is built to make that convergence possible later; doing it here balloons the diff.
- **Edit-mode rendering** — edit mode retains raw Markdown for authoring (AC5); no change.
- Document-editor / TipTap markdown behavior (separate, already-tracked work).

### The before/after diff constraint (critical — governs U3)

`DetailDiffSection` is a **before/after diff**, not a plain field. Today the diff signal is
carried in **two** places: the pane chrome (before = `border-destructive/30 bg-destructive/5` +
a "Before" label; after = `border-success/30 bg-success/5` + an "After" label) **and** the body
text (`line-through text-destructive/90` / `text-success`). Applying `prose` on top of
body-colored, struck-through text would fight the prose color tokens and render struck-through
headings/tables.

**Resolution (satisfies AC4):** the chrome already carries the diff signal — keep it, and drop
the **body-level** color/`line-through` so the body renders as neutral Markdown. This matches the
existing in-app precedent where diff semantics live on pane chrome, not body text:
[`VersionDiffViewer.tsx:325-368`](apps/web/modules/saas/projects/components/VersionDiffViewer.tsx#L325-L368)
and [`DiffPreviewPanes.tsx:112-124`](apps/web/modules/saas/projects/components/DiffPreviewPanes.tsx#L112-L124)
(neutral `prose` body; diff read from the frame). The section-level `opacity-60` on `isRejected`
([`BacklogChangeDetailDialog.tsx:844`](apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx#L844))
stays as the rejected-state signal.

### Success Criteria

- **AC1:** Proposal descriptions/AC containing Markdown (headings, bold, italic, lists, tables,
  code blocks) render as formatted output in the review modal's view mode.
- **AC2:** Applies globally to all existing and new proposals with no user action.
- **AC3:** Raw Markdown characters (`**`, `##`, `|`, `-`) are not visible where valid Markdown is
  present — rendered in full views, stripped in clamped previews.
- **AC4:** Rendering is visually consistent with the rest of the app (shared prose primitive; diff
  semantics on chrome, not body).
- **AC5:** No regression in edit mode (raw Markdown retained for authoring).
- The staging reproduction case (`**Steps to Reproduce**` etc.) renders formatted.

### Decisions

- **Always-on rendering, not autodetect.** These fields are consistently authored/generated as
  Markdown; always-on is simpler and correct.
- **Radius = shared primitive + proposal cluster + maturation panels** (not modal-only, not
  full-codebase consolidation).
- **Clamped previews get a lightweight regex strip helper** (not block rendering) — keeps list
  layout intact while clearing AC3. Chosen by product authority.
- **Maturation panels included** despite rendering meeting-digest content (a different field than
  proposal desc/AC): same bug class, trivial low-risk swap, part of the feature-maturation flow.

### Dependencies / Assumptions

- `react-markdown@^10` + `remark-gfm@^4` already installed (`apps/web/package.json`) — **no new
  dependency**.
- `react-markdown` does **not** render raw HTML by default (no `rehype-raw` in the primitive), so
  no separate sanitizer is needed for these fields. The `markdown-it` + DOMPurify +
  `dangerouslySetInnerHTML` path in `ProjectPipeline.tsx` is deliberately **not** the model here.
- Prose color tokens render legibly on the tinted diff-box backgrounds (`bg-destructive/5`,
  `bg-success/5`); verify visually in U3.

---

## Key Technical Decisions

- **KTD1 — One primitive, thin wrapper.** `<Markdown>` wraps `ReactMarkdown` +
  `remarkPlugins={[remarkGfm]}` inside the canonical `prose prose-sm dark:prose-invert max-w-none`
  div, mirroring `AtlasNodePanel`. Accept an optional `className` merged via `cn` so callers can
  add `line-clamp-*` or spacing. No `rehype-raw`, no custom `components` override in v1 (link
  handling can follow later — see Open Questions).
- **KTD2 — Strip, don't render, in clamps.** Block-level Markdown (headings, tables, lists) breaks
  a 2-line `line-clamp`. `stripMarkdown(text)` reduces common inline/block syntax to readable plain
  text (`**Steps to Reproduce**` → `Steps to Reproduce`) and the existing `line-clamp-2 <p>` is
  kept. Regex-based, pure, dependency-free.
- **KTD3 — Diff signal moves fully to chrome in U3.** Drop body `line-through`/color; keep box
  border/bg + Before/After labels + `isRejected` section opacity. Precedent: `VersionDiffViewer`,
  `DiffPreviewPanes`.

---

## Implementation Units

### U1. Shared `<Markdown>` primitive

- **Goal:** A single reusable Markdown renderer in the UI module.
- **Requirements:** AC1, AC4. Enables U3, U5.
- **Dependencies:** none.
- **Files:**
  - `apps/web/modules/ui/components/markdown.tsx` (new) — `@ui/components/markdown`
  - `apps/web/modules/ui/components/__tests__/markdown.test.tsx` (new)
- **Approach:** Client component. Props `{ children: string; className?: string }`. Render
  `<div className={cn("prose prose-sm dark:prose-invert max-w-none", className)}>` wrapping
  `<ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>`. No `rehype-raw`. Export
  a named `Markdown`.
- **Patterns to follow:** [`AtlasNodePanel.tsx:834-846`](apps/web/modules/saas/projects/components/atlas/AtlasNodePanel.tsx#L834-L846)
  (wrapper class + plugin set); `cn` from `@ui/lib`.
- **Test scenarios:**
  - Covers AC1. Bold `**x**` renders a `<strong>`; `## H` renders a heading element; `- a\n- b`
    renders a `<ul>` with two `<li>`; a GFM pipe table renders a `<table>`; a fenced code block
    renders `<pre><code>`.
  - Covers AC3. Raw `**` / `##` / `|` characters are absent from rendered text content when the
    syntax is valid.
  - `className` prop is merged onto the wrapper (e.g. passing `line-clamp-[7]` appears in the
    wrapper's class list).
  - Raw-HTML safety: input containing `<script>alert(1)</script>` does not produce a `<script>`
    element (react-markdown default, no rehype-raw).
- **Verification:** Component renders formatted HTML for a Markdown string; unit tests green.

### U2. `stripMarkdown` helper

- **Goal:** Reduce Markdown to readable plain text for clamped previews.
- **Requirements:** AC3. Enables U4.
- **Dependencies:** none.
- **Files:**
  - `apps/web/modules/ui/lib/strip-markdown.ts` (new) — `@ui/lib/strip-markdown`
  - `apps/web/modules/ui/lib/__tests__/strip-markdown.test.ts` (new)
- **Approach:** Pure `stripMarkdown(input: string): string`. Lightweight regex pass covering the
  syntax the LLM actually emits: `**bold**`/`__bold__` → text, `*italic*`/`_italic_` → text,
  leading `#{1,6} ` heading markers → removed, leading `- `/`* `/`1. ` list markers → removed,
  inline `` `code` `` backticks → removed, `[label](url)` → `label`, table pipe rows collapsed to
  spaced cells, blockquote `> ` removed, collapse runs of whitespace/newlines to single spaces.
  Directional — implementer tunes the regex set; keep it small and total (never throws, returns
  input on no-match).
- **Test scenarios:**
  - `**Steps to Reproduce**` → `Steps to Reproduce`.
  - `## Overview` → `Overview`; `- item one` → `item one`.
  - `[docs](https://x)` → `docs`.
  - A pipe table row `| a | b |` → readable `a b` (no bare `|` runs).
  - Plain text with no Markdown is returned unchanged.
  - Empty string / whitespace-only returns empty; never throws on odd input (`**unclosed`).
- **Verification:** Helper output contains no residual `**`, `##`, leading `- `, or `|` for the
  scenarios above; unit tests green.

### U3. Render Markdown in the review modal diff panes

- **Goal:** The proposal review modal renders `description` + `acceptanceCriteria` as formatted
  Markdown, with the diff signal on chrome only.
- **Requirements:** AC1, AC3, AC4, AC5. The primary staging-reproduced surface.
- **Dependencies:** U1.
- **Files:**
  - `apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx` (modify
    `DetailDiffSection`, ~L868-909)
  - `apps/web/modules/saas/projects/components/stories/__tests__/BacklogChangeDetailDialog.test.tsx`
    (extend)
- **Approach:** In `DetailDiffSection`, replace the "Before" body `<p>` ([:873](apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx#L873))
  and the "After" body `<p>` ([:898-908](apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx#L898-L908))
  with `<Markdown>`. Drop body-level `line-through` and `text-destructive/90` / `text-success` /
  `text-muted-foreground line-through` — the box border/bg + Before/After labels already carry the
  diff signal, and the `isRejected` section `opacity-60` ([:844](apps/web/modules/saas/projects/components/stories/BacklogChangeDetailDialog.tsx#L844))
  stays. Keep `placeholder`/`(empty)` handling for empty `to`. `MetadataField` (short scalars)
  is untouched. Edit mode is a separate control path — unchanged (AC5).
- **Patterns to follow:** neutral-body diff panes in `VersionDiffViewer` / `DiffPreviewPanes`.
- **Test scenarios:**
  - Covers AC1. A `change` whose `description.to` contains `**bold**` + `## heading` renders
    `<strong>` / heading, not literal `**`/`##` (query the dialog's description section).
  - Covers AC3. Rendered text content of the After pane contains no `**`/`##` for valid Markdown.
  - Before/after: when `from !== to`, both panes render and the diff chrome (destructive/success
    box classes + Before/After labels) is present; body carries no `line-through` class.
  - `isRejected` still mutes the section (opacity) and does not crash with Markdown children.
  - Empty `to` with a `placeholder` still shows the placeholder (no Markdown of an empty string).
- **Verification:** On staging-equivalent data, the modal shows formatted headings/bold/lists;
  the reproduction string renders formatted; existing `BacklogChangeDetailDialog` tests stay green.

### U4. Strip Markdown in clamped previews

- **Goal:** Card and inbox 2-line previews show clean text, no raw syntax, no broken layout.
- **Requirements:** AC3.
- **Dependencies:** U2.
- **Files:**
  - `apps/web/modules/saas/projects/components/stories/BacklogChangeProposal.tsx` (card
    description ~L1732, reasoning ~L1800)
  - `apps/web/modules/saas/projects/components/stories/PendingBacklogProposalsInbox.tsx` (summary
    ~L1449, ~L1537)
  - Extend an existing `BacklogChangeProposal.*.test` or add
    `apps/web/modules/saas/projects/components/stories/__tests__/BacklogChangeProposal.preview-strip.test.tsx`
- **Approach:** Wrap the string expressions feeding the `line-clamp-2 <p>` sites with
  `stripMarkdown(...)`. Keep the `line-clamp-2` class and element. Do not render `<Markdown>` here
  (block elements break the clamp — see KTD2).
- **Patterns to follow:** existing preview `<p className="... line-clamp-2">` sites; leave
  surrounding structure intact.
- **Test scenarios:**
  - Covers AC3. A proposal whose description is `**Steps to Reproduce** ...` renders preview text
    `Steps to Reproduce ...` — no `**`.
  - Reasoning preview with `## ` heading syntax renders without the `##`.
  - Inbox summary with list/table syntax renders as single-line readable text (no bare `|`).
  - A plain-text proposal preview is unchanged.
- **Verification:** Preview text in cards/inbox contains no residual Markdown tokens; layout is
  still 2-line clamped; tests green.

### U5. Render Markdown in maturation panels

- **Goal:** Full-view maturation content renders formatted Markdown.
- **Requirements:** AC1, AC4.
- **Dependencies:** U1.
- **Files:**
  - `apps/web/modules/saas/projects/components/stories/maturation/SummaryQuestionsPanel.tsx`
    (thread content [:225](apps/web/modules/saas/projects/components/stories/maturation/SummaryQuestionsPanel.tsx#L225),
    digest [:355](apps/web/modules/saas/projects/components/stories/maturation/SummaryQuestionsPanel.tsx#L355))
  - `apps/web/modules/saas/projects/components/stories/maturation/DecisionLogPanel.tsx`
    (reply content [:326](apps/web/modules/saas/projects/components/stories/maturation/DecisionLogPanel.tsx#L326))
- **Approach:** Replace each full (non-clamped) `<p className="whitespace-pre-wrap text-sm
  leading-relaxed ...">` body with `<Markdown>`, carrying the existing color intent via the
  wrapper `className` where needed (e.g. `text-muted-foreground`). These are not diffs and not
  clamped — a straight swap. Leave short scalar labels (e.g. `thread.root.summary` at
  [:221](apps/web/modules/saas/projects/components/stories/maturation/SummaryQuestionsPanel.tsx#L221))
  as plain `<p>`; only the long-form content bodies change.
- **Patterns to follow:** U1 primitive; `AtlasNodePanel` usage.
- **Test scenarios:**
  - Covers AC1. A thread whose `content` contains Markdown renders formatted, not literal syntax.
  - The digest body renders Markdown; a plain-text digest is unaffected.
  - `Test expectation: light` — one render assertion per panel is sufficient (mechanical swap,
    behavior identical to U1 which is covered in depth).
- **Verification:** Maturation summary/decision content renders formatted; panels still mount with
  empty/`null` content.

---

## Verification Contract

- `pnpm --filter web test apps/web/modules/ui/components/__tests__/markdown.test.tsx`
- `pnpm --filter web test apps/web/modules/ui/lib/__tests__/strip-markdown.test.ts`
- `pnpm --filter web test apps/web/modules/saas/projects/components/stories/__tests__/BacklogChangeDetailDialog.test.tsx`
- `pnpm --filter web test` (proposal/inbox preview + maturation suites) green.
- `pnpm type-check` and `pnpm lint` clean for touched files.
- Manual (staging-equivalent): the reproduction modal (`**Steps to Reproduce**` …) renders
  formatted; card/inbox previews show clean text; light and dark themes both legible.

---

## Definition of Done

- U1–U5 landed; all Verification Contract gates green.
- AC1–AC5 satisfied; staging reproduction case renders formatted.
- No new dependency added; no raw-HTML rendering path introduced.
- A `.changeset/*.md` bumping `fabric-app: patch` with a one-line CHANGELOG headline.
- Deferred items (inline-call-site migration, edit-mode) remain out of scope and are recorded.

---

## Open Questions (deferred to implementation)

- Does `<Markdown>` need a `components={{ a: ... }}` link override (as `ContextSummaryMarkdown`
  uses) in v1, or can it wait for the follow-up consolidation? Default: wait.
- Exact regex set for `stripMarkdown` — tune against real proposal bodies during U2.

---

*Grounding dossier:* `scratchpad/grounding.md` (this session). *Staging repro:*
`scratchpad/repro/repro-detail-dialog.png`.

---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
type: fix
title: "fix: Document editor masthead overflows under the AI assistant panel at narrow widths"
date: 2026-07-28
branch: fix/document-editor-masthead-overflow
status: implementation-ready
---

# fix: Document Editor Masthead Overflows Under the AI Assistant Panel — Plan

## Summary

The Document editor's page-chrome masthead (breadcrumb row + action bar) is a set of non-shrinking `flex` rows that spill **under** the docked AI Document Assistant panel at narrow widths — the identical bug already fixed on the story/feature editor (Fizzy #2025). The Document editor already reserves editor-body space for the panel (breakpoint fix merged to master) but never got the masthead scroll fix. This applies the same proven one-token-per-row change — `min-w-0 overflow-x-auto` — to the two overflowing rows so they scroll within the editor column instead of rendering under the panel.

---

## Problem Frame

The AI assistant panel (`<CopilotSidebar>`) docks as a fixed 28rem right rail at `min-width: 640px`. Each editor page reserves space for it by shifting its fixed page-chrome wrapper (`AI_SIDEBAR_CONTENT_SHIFT_CLASS`, gated on `useAiSidebarExpanded`) — already present on the Document editor. But the masthead rows *inside* that wrapper are `flex` rows with `min-width: auto` and no overflow handling, so when the reserved column is narrower than their content (any viewport below ~1100px, worst in the 640–767px band) they overflow horizontally under the panel.

The **story editor** was fixed by adding `min-w-0 overflow-x-auto` to its masthead rows — merged to master, deployed, verified on staging, confirmed by the reporter. The **Document editor** has the byte-identical masthead pattern ("Three-line header: title → breadcrumb → action bar, consistent with the feature editor" per its own code comment) but was not included. This closes that gap — the last editor surface with this pattern.

---

## Requirements

- **R1** — The Document editor's breadcrumb and action-bar rows must not render under the docked AI panel at any viewport ≥640px; overflowing rows scroll horizontally within the editor column instead.
- **R2** — Behavior is unchanged where content already fits (wide screens: no scrollbar) and for the editor body (already reserved) and the title row (already truncates via `min-w-0`).
- **R3** — No regression to the panel-hosted controls (dropdowns/tooltips must still open — they portal to `body`, so `overflow-x-auto` won't clip them; validated on the story editor).

---

## Key Technical Decisions

**KTD1 — Reuse the exact story-editor fix: `min-w-0 overflow-x-auto` per overflowing masthead row.** Same mechanism, same classes, same surface pattern. `min-w-0` lets the flex row shrink to the column; `overflow-x-auto` clips+scrolls the non-shrinking content within it (a horizontal scrollbar appears only when content doesn't fit). Matches the app's existing scroll-tab convention. No new abstraction — it's a 2-row mirror of shipped code.

**KTD2 — Only the breadcrumb (Line 2) and action bar (Line 3) need it.** Line 1 (title) already carries `min-w-0` and truncates. Documents have no maturation tabs (unlike stories), and the TipTap formatting toolbar wraps on its own (confirmed on the story Classic editor). The two `overflow-x-auto` occurrences already in `DocumentEditor.tsx` are `overflow-y-auto overflow-x-auto` on font-mono content/diff boxes — unrelated to the masthead; leave them.

**KTD3 — `overflow-x-auto`'s vertical-clip caveat is safe here.** Setting `overflow-x: auto` forces `overflow-y` to compute to `auto`, which could clip downward-opening popovers — but the action-bar controls are Radix (DropdownMenu/Tooltip/Popover) that render in a portal, escaping the row. Verified non-issue on the identical story-editor action bar.

---

## Implementation Units

### U1. Add horizontal-scroll to the Document editor masthead rows

**Goal:** Stop the breadcrumb and action-bar rows from overflowing under the AI panel by scrolling them within the editor column. (R1, R2, R3; KTD1–KTD3)

**Dependencies:** none.

**Files:**
- `apps/web/modules/saas/projects/components/DocumentEditorPage.tsx` — two one-line className edits:
  - **Line 2 — breadcrumb row** (~[line 379](apps/web/modules/saas/projects/components/DocumentEditorPage.tsx#L379)): `flex items-center gap-3 px-6 pb-4 bg-background border-b` → append `min-w-0 overflow-x-auto`.
  - **Line 3 — action bar row** (~[line 517](apps/web/modules/saas/projects/components/DocumentEditorPage.tsx#L517)): `flex items-center gap-2 px-6 py-2 border-b bg-background` → append `min-w-0 overflow-x-auto`.

**Approach:** Mirror `StoryWorkspacePage.tsx` (its breadcrumb row and action-bar row carry the same two classes, shipped). Do not touch Line 1 (title) or `DocumentEditor.tsx`. Confirm the exact class strings by reading the rows before editing (line numbers are approximate).

**Patterns to follow:** `StoryWorkspacePage.tsx` breadcrumb + action-bar rows (the merged story-editor fix); the app's scroll-tab pattern in `ProjectDetails.tsx`.

**Test scenarios:**
- Test expectation: none (CSS-only className change; verification is DOM/visual on staging — see Verification). No unit test — asserting a Tailwind className string inside this provider-heavy page is a change-detector with no behavioral value, and the story-editor equivalent shipped without one.

**Verification (per-unit):**
- Grep confirms both rows carry `min-w-0 overflow-x-auto`; no other `DocumentEditorPage` masthead row changed.
- `pnpm --filter web type-check` adds no new errors; Biome clean on the file.
- Staging DOM/visual verification below passes.

### U2. Changeset

**Goal:** Record the user-facing fix for release.

**Dependencies:** U1.

**Files:**
- `.changeset/<generated-name>.md` — **new.** Frontmatter bumps **only** `"fabric-app": patch`. Body line 1 headline, e.g.: `Fix the Document editor masthead overflowing under the AI assistant panel at narrow widths.`

**Test scenarios:** Test expectation: none — release metadata.

**Verification (per-unit):** file exists with non-empty frontmatter declaring `fabric-app: patch`.

---

## Verification

**Executable this session (staging DOM injection — no deploy needed).** On the staging host, open a project **document** with the AI Document Assistant panel docked, at **1024px** and **767px**. First measure the current (unfixed, deployed) state — the breadcrumb/action-bar rows extend past the panel's left edge. Then apply the fix's exact CSS (`min-width: 0; overflow-x: auto`) to those two rows via `browser_evaluate` and re-run a **visible-overlap scan** (walk the editor chrome, computing each element's effective right edge after clipping ancestors; assert nothing paints past the panel's left edge). Screenshot before/after. This is the proven method from the story-editor fix.

**Holistic check:** the scan must find **zero** editor elements painting under the panel after the fix — not just the two known rows — to confirm no other document toolbar/status row overflows.

**Post-deploy (native) confirmation:** once deployed, re-open the document at 1024/767px and confirm the two rows show `overflow-x: auto` (computed), each row's right edge meets the panel's left edge, and the visible-overlap scan is clean. Regression check: ≥1200px shows no scrollbars (content fits), and the editor body + title behave unchanged.

---

## Scope Boundaries

**In scope:** the two Document editor masthead rows (breadcrumb + action bar); a changeset.

**Out of scope:** Line 1 title (already `min-w-0`), `DocumentEditor.tsx` content/diff scroll boxes, the TipTap toolbar (wraps on its own), and the agent pages (document-generator / task-planner — breadcrumb-only mastheads, no heavy action bar). No breakpoint/reservation changes (already merged).

---

## Risks & Dependencies

- **Vertical-clip of a non-portaled popover (low).** `overflow-x: auto` forces `overflow-y: auto`; a downward popover rendered as a DOM child (not portaled) could clip. Mitigation: the action-bar controls are Radix-portaled; verified non-issue on the identical story action bar. The staging screenshot check covers it.
- No data, API, auth, migration, or tenant surface — CSS-only, tenant-agnostic (same component in personal and org contexts).

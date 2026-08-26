---
title: Tooltip Accessibility Follow-ups - Plan
type: fix
date: 2026-07-21
topic: tooltip-a11y-followups
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Tooltip Accessibility Follow-ups - Plan

- **Audience**: frontend engineers finishing the tooltip accessibility work
- **Owner**: web app team

**Product Contract preservation:** changed — item 2 approach. The requirements draft called for a React node-view port; grounding found the toolbar is already a React component whose controls carry `aria-label` (a11y intact), so the port is a ~200-line rewrite for no accessibility gain. The user chose option B (drop native `title`, document the imperative-overlay exception) in the 2026-07-21 planning dialogue. The intent — image-toolbar controls off native `title`, routed appropriately — is preserved; only the mechanism changed. Rest of the Product Contract unchanged.

## Goal Capsule

- **Objective:** Close the genuine remainder of the four approved tooltip follow-ups, after the brainstorm found that two of the four are already resolved by the merged Stage 2 work.
- **Product authority:** Confirmed in brainstorm + planning dialogue on 2026-07-21. Scope cut from "four items" to what actually remains once the merged Stage 2 PR is accounted for.
- **Execution profile:** Standard, six units, all low-risk. No 98-site sweep — that was a phantom. Mostly small, targeted edits plus one design-approved fold.
- **Stop conditions:** Stop and surface if folding the delete-confirm buttons onto `variant="destructive"` regresses anything beyond appearance, or if a `<time>` conversion would touch a site already using the sanctioned `<time title=>` exception.
- **Tail ownership:** The user owns commit, push, and PR. Do not commit.

---

## Product Contract

### Summary

Of the four approved follow-ups from the merged Stage 2 tooltip PR, the brainstorm established that **two are already done**. Item 4 (red text under AA) was fixed by the `--destructive: #c81e1e` darkening that shipped in the same PR — light-mode `text-destructive` now measures 5.31 / 5.65 / 4.90 across `--background` / `--card` / `--muted`, all passing. Item 1 ("98 non-focusable tooltips") is largely resolved too: the Stage 2 migration applied the `sr-only` (status chips) and `role="img"`/`aria-label` (capability chips) remediation inline as it wrapped each `title=`. A triage of 30+ of the flagged sites found **zero genuinely-broken interactive elements** remaining.

What genuinely remains is small: a handful of real item-1 defects the triage surfaced, the image-toolbar cleanup (item 2), and the design-approved fold of the delete-confirm buttons (item 3).

### Problem

The four items were catalogued in `docs/plans/2026-07-20-002-fix-native-title-migration-audit.md`, which captured the **pre-migration** state. The audit's line numbers and its "98 non-focusable, separate batch" framing are stale: the migration that followed already handled the bulk. Re-doing that work would be churn or regression. The remaining defects are the ones the migration could not resolve mechanically.

### Requirements

- **R1 (item 1-A):** Citation markers must not imply clickability they lack. The marker carries `cursor-pointer hover:bg-primary/20` but no `onClick`/`href`; the real link is a separate `<a>`. Remove the false affordance.
- **R2 (item 1-B):** A collapsed, disabled nav row must announce its name to a screen reader. Today, when the sidebar is collapsed, the label lives only in a pointer-only tooltip.
- **R3 (item 1-C):** The `<span>`/`<small>` sites the audit classified `EXCEPTION-time` must become `<time dateTime={…}>` so the carve-out is real. Only the audit's list — never a site already using `<time title=>`.
- **R4 (item 1-D):** The interactive `EXCEPTION-truncation` sites (a `<button>` relying on native `title` for its truncated label) must use the shared `<Tooltip>`. Skip sites whose interactivity is on a parent `<button>` already.
- **R5 (item 2):** The image-toolbar controls must not use native `title`. Drop the five `title=` assignments (keep the existing `aria-label`s) and record imperative overlays as an explicit exception in the tooltip standard.
- **R6 (item 3):** Delete-confirm buttons fold onto `<Button variant="destructive">`; the now-unused `destructiveActionClassName` export is removed. Muted dark-mode appearance accepted.

### Scope boundaries

**In scope**
- Item 1 A/B/C/D as above.
- Item 2 native-`title` removal + standard update.
- Item 3 fold + removal of the shared const.

**Explicitly out of scope**
- **Item 4.** Already shipped. Touching it would be a no-op or a regression.
- **Dark-mode destructive contrast.** Both the current delete buttons and `variant="destructive"` measure ~3.76–3.79:1 (white on `--destructive #ef4444`), below the 4.5:1 AA floor. Folding onto the variant does **not** fix this and is not expected to. Pre-existing, app-wide token issue the user chose to leave for a separate change; a known limitation of item 3, not a defect this ticket introduces.
- **A React-portal rewrite of the image toolbar (item 2 option A).** Rejected in planning — a11y is already intact, so the rewrite is cost without accessibility benefit.

### Success criteria

- Citation markers no longer imply clickability they lack (R1).
- A collapsed, disabled nav row announces its name to a screen reader (R2).
- Every audit-listed `EXCEPTION-time` span is a `<time dateTime>` (R3); no already-`<time>` site altered.
- The flagged interactive-truncation buttons open a real tooltip on hover and focus (R4).
- The image toolbar's controls carry no native `title`; `aria-label`s preserved; the standard documents the exception (R5).
- Delete-confirm dialogs use `variant="destructive"`; `destructiveActionClassName` is gone; no call site references it (R6).
- No new WCAG 2.5.3 (Label in Name) regressions — the Stage 2 trap where `aria-label` replaced a visible name. Any new `aria-label` on an element with visible text must contain that text.

### Dependencies and assumptions

- **Verified 2026-07-21:** the merged Stage 2 remediation is present on `master` — the `deleted` chip carries its `sr-only` child, model-capability chips carry `role="img"` + `aria-label`, and the flagged interactive rows were already promoted to `<button>`.
- **Verified:** the citation false affordance is real — `cursor-pointer` at `components/ai-elements/inline-citation.tsx:50/79` with the actual link on a separate `<a>` at `:103`.
- The `<time>` conversion depends on the audit's EXCEPTION-time list being the authority over a raw grep (a bare `title={date}` grep also matches sanctioned `<time title=>` sites).

---

## Key Technical Decisions

- **KTD1 — item 1-A: drop the affordance, don't wire an action.** The marker has no action to attach; the citation link already exists as a sibling `<a href={citation.url}>`. Remove `cursor-pointer` and the `hover:bg-primary/20` from the marker so it reads as static text. (Outstanding Question below records the alternative of making it actionable — default is drop.)
- **KTD2 — item 2: keep the imperative overlay, remove native `title`.** The toolbar is built with `document.createElement` because it positions over arbitrary ProseMirror image nodes; there is no `TooltipProvider` in that subtree. The five buttons already set `aria-label` via `setAttribute`, so removing `title` costs no accessibility. A React-portal rewrite (to reach `<Tooltip>`) is rejected as disproportionate. The tooltip standard gains a fourth documented exception: controls in imperatively-built overlays outside the React tree.
- **KTD3 — item 3: fold onto the existing `variant`, accept the muted look.** `variant="destructive"` paints `dark:bg-destructive/60`; the current shared class paints full-strength `--destructive`. The user reviewed both in dark mode on staging and chose the fold for code consistency. Contrast is unchanged (~3.76:1 either way) and out of scope.
- **KTD4 — `<time>` conversion is per-site, list-driven.** Convert only the audit's EXCEPTION-time `<span>`/`<small>` entries; leave `<time title=>` sites untouched. This is the sanctioned carve-out being made real, not a blanket sweep.

---

## Implementation Units

### U1. Citation marker false affordance

- **Goal:** Stop the citation marker from implying it is clickable when it is not (R1, KTD1).
- **Dependencies:** none.
- **Files:** `apps/web/components/ai-elements/inline-citation.tsx` (markers at ~:50, ~:79), `apps/web/components/ai-elements/sources.tsx` (marker at ~:179). Test: extend `apps/web/components/ai-elements/__tests__/` coverage if a suite exists for these; otherwise assert in the nearest citation test.
- **Approach:** Remove `cursor-pointer` and `hover:bg-primary/20` from the marker span's className. Leave the real `<a href={citation.url}>` (at `:103`/`:174` in inline-citation, `:123` in sources) and its behavior untouched. Keep any existing `sr-only`/`role` on the marker.
- **Patterns to follow:** the sibling `<a>` is the sanctioned interactive element; the marker stays presentational.
- **Test scenarios:**
  - The marker element does not carry `cursor-pointer` after the change.
  - The citation link (`<a href>`) still renders and still points at `citation.url`.
  - `Covers R1.` Hovering the marker produces no pointer-affordance styling (assert class absence, since jsdom won't compute cursor).
- **Verification:** marker reads as static; the separate link remains the only interactive affordance.

### U2. Collapsed disabled nav row accessible name

- **Goal:** Give a screen reader the label of a disabled nav row when the sidebar is collapsed (R2).
- **Dependencies:** none.
- **Files:** `apps/web/modules/saas/shared/components/NavBar.tsx` (disabled branch ~:860–893). Test: `apps/web/modules/saas/shared/components/__tests__/NavBar.test.tsx` if present; otherwise the nearest NavBar test.
- **Approach:** In the collapsed+disabled branch, the label currently exists only inside the pointer-only `<Tooltip>`. Add an `sr-only` span (or `aria-label` on the row) carrying `item.label` so assistive tech announces it in the collapsed state. Do not add `aria-label` that would replace a visible name in the expanded state — apply only to the collapsed branch. Confirm the Radix trigger still fires given `cursor-not-allowed` / `aria-disabled` (those do not set `pointer-events: none`, so it should).
- **Patterns to follow:** the `sr-only` remediation used on the `deleted` chip in `BacklogAuditDialog.tsx` (merged Stage 2).
- **Test scenarios:**
  - `Covers R2.` Collapsed + disabled row exposes an accessible name equal to `item.label` (query by role/name or assert the `sr-only` text).
  - Expanded row is unchanged — no new `aria-label` shadowing the visible label (WCAG 2.5.3).
- **Verification:** a collapsed disabled row has a non-empty accessible name; the expanded row's accessible name is still its visible text.

### U3. Timestamp spans become `<time>`

- **Goal:** Make the `EXCEPTION-time` carve-out real by converting the audit-listed `<span>`/`<small>` timestamp sites to `<time dateTime>` (R3, KTD4).
- **Dependencies:** none.
- **Files (audit EXCEPTION-time list):** `apps/web/modules/marketing/changelog/components/ChangelogSection.tsx`, `apps/web/modules/saas/data-connections/components/IntegrationIncidentDrawer.tsx`, `apps/web/modules/saas/projects/components/DocumentAutoRefreshToggle.tsx` (~:450), `apps/web/modules/saas/projects/components/DocumentVersionHistory.tsx`, `apps/web/modules/saas/projects/components/UrlSourcePageView.tsx` (~:1990), `apps/web/modules/saas/projects/components/stories/FeatureVersionHistory.tsx`, `apps/web/modules/saas/settings/components/user-activity/MemberActivityDrawer.tsx`, `apps/web/modules/saas/settings/components/user-activity/MemberActivityTable.tsx`.
- **Approach:** Replace `<span title={date…}>` / `<small title={date…}>` with `<time dateTime={isoString}>`, where `dateTime` is a machine ISO value and the visible child stays the human-readable relative/formatted text. The native `title` (full timestamp) is preserved on the `<time>` element per the sanctioned `<time title=>` exception. **Before editing each site, confirm it is on the audit list and not already a `<time>`** — a raw grep over-matches.
- **Patterns to follow:** existing `<time dateTime=… title=…>` usages already in the tree (e.g. security scan timestamps).
- **Test scenarios:**
  - `Covers R3.` Each converted site renders a `<time>` element with a valid `dateTime` attribute.
  - The visible text is unchanged from before the conversion.
  - No site already using `<time>` was modified (spot-check the exclusion holds).
- **Verification:** the eight sites are `<time dateTime>`; no `<time title=>` site was touched.

### U4. Interactive truncation buttons use the shared tooltip

- **Goal:** Route the interactive `EXCEPTION-truncation` buttons through `<Tooltip>` so their truncated label is available on hover and keyboard focus (R4).
- **Dependencies:** none.
- **Files (audit interactive-truncation set, verify each before editing):** `apps/web/modules/saas/projects/components/atlas/AtlasChatPanel.tsx` (~:944), `apps/web/modules/saas/projects/components/security/ScanFindingsList.tsx` (~:1078), `apps/web/modules/saas/meeting-digest/components/CalendarCanvas.tsx` (~:65), `apps/web/modules/saas/projects/components/stories/RoadmapFiltersPanel.tsx` (~:176), `apps/web/modules/saas/shared/components/copilot/MessageAttachmentList.tsx` (~:132), plus the remaining flagged story/tiptap buttons from the audit. **Skip** sites whose interactivity is on a parent `<button>` (e.g. `StoryCard.tsx`).
- **Approach:** Wrap the button in `<Tooltip><TooltipTrigger asChild>…</TooltipTrigger><TooltipContent>{fullText}</TooltipContent></Tooltip>`, removing the native `title`. Copy goes through i18n per the standard where a key fits; where the content is a pure data string (a truncated title the user already sees expanded elsewhere), a direct string is acceptable — match how the migrated siblings handled it. Do not add an `aria-label` that would replace the button's visible name.
- **Patterns to follow:** the Stage 2 migrations in the same modules; the tooltip standard's decision order.
- **Test scenarios:**
  - `Covers R4.` A flagged button opens a tooltip carrying the full (untruncated) text on hover.
  - The button's accessible name still contains its visible text (no 2.5.3 regression).
  - A skipped parent-button site is left unchanged (guard against over-reach).
- **Verification:** each converted button has a `data-slot="tooltip-trigger"` and no native `title`; skipped sites untouched.

### U5. Image toolbar off native `title` + standard exception

- **Goal:** Remove the five native `title` assignments from the imperative image toolbar and document imperative overlays as an exception (R5, KTD2).
- **Dependencies:** none.
- **Files:** `apps/web/modules/saas/projects/components/ImageSelectionToolbar.tsx` (`title` at ~:158 (×3 size buttons via the loop), ~:194, ~:230), `fabric/standards/frontend/tooltips.md` (exception list). Test: `apps/web/modules/saas/projects/components/__tests__/ImageSelectionToolbar.test.tsx`.
- **Approach:** Delete the `btn.title = …`, `captionBtn.title = …`, `delBtn.title = …` assignments. Leave every `setAttribute("aria-label", …)` in place — that is the accessibility contract and it is already satisfied. Add a bullet to the tooltip standard's `❌ DON'T` native-`title` exception list: controls built imperatively (`document.createElement`) in an overlay outside the React tree, where no `TooltipProvider` is in scope, keep their `aria-label` and take no tooltip — name `ImageSelectionToolbar.tsx` as the example.
- **Patterns to follow:** the existing exception entries in `fabric/standards/frontend/tooltips.md` (iframe, `<time>`, `select.tsx` truncation affordance).
- **Test scenarios:**
  - `Covers R5.` Each toolbar button has no `title` attribute after render.
  - Each toolbar button still exposes its `aria-label` (size S/M/L, caption, delete).
  - `Test expectation: standard doc` — the exception list gains the imperative-overlay entry (prose change, no unit test).
- **Verification:** toolbar buttons carry `aria-label` and no `title`; the standard names the exception.

### U6. Fold delete-confirm buttons onto `variant="destructive"`

- **Goal:** Replace the shared `destructiveActionClassName` usage with `<Button variant="destructive">` at the 18 call sites and remove the now-unused export (R6, KTD3).
- **Dependencies:** none (independent of U1–U5).
- **Files (17 files, 18 sites):** `apps/web/modules/ui/components/button.tsx` (remove the export), plus: `weave/components/WeavePlanList.tsx`, `weave/components/WeaveExecutionMonitor.tsx`, `settings/components/DeleteAccountForm.tsx`, `settings/components/OrgOpenAPISettingsForm.tsx`, `settings/components/UserOpenAPISettingsForm.tsx`, `settings/components/AiProvidersSettingsForm.tsx`, `settings/components/mcp/components/McpDeleteDialogs.tsx` (×2), `payments/components/AiUsageLimitEditSheet.tsx`, `automation-templates/components/DeleteTemplateDialog.tsx`, `projects/components/copilot/CopilotHistoryDrawer.tsx`, `projects/components/security/SecurityAccessibilityPage.tsx`, `projects/components/atlas/AtlasAnalyzingState.tsx`, `workflows/components/integrations/WorkflowIntegrationSettingsPageContent.tsx`, `workflows/lib/plugins/gitlab/GitLabSettings.tsx`, `agent-templates/components/AgentInstanceDetail.tsx`, `agent-templates/components/AgentMemoryPanel.tsx`, `data-connections/components/ConnectionCard.tsx` (all under `apps/web/modules/saas/`). Test: `apps/web/modules/ui/components/__tests__/` for the const removal; existing delete-dialog tests for behavior.
- **Approach:** At each site, replace `className={destructiveActionClassName}` (or the class merged into a `cn(...)`) with `variant="destructive"` on the `<Button>` / `AlertDialogAction`. Where the site is `AlertDialogAction` composing `buttonVariants()`, pass `variant="destructive"` through its variant prop. Confirm no site relied on the `hover:bg-destructive/90` beyond what the variant already provides. Remove the `destructiveActionClassName` export from `button.tsx` and its now-dead import in each file. Grep to confirm zero references remain.
- **Execution note:** mechanical and wide; a single agent should do the whole set in one pass to keep the diff coherent, then run the shared-button and delete-dialog suites.
- **Patterns to follow:** the existing `variant="destructive"` call sites already in the app.
- **Test scenarios:**
  - `Covers R6.` No source file references `destructiveActionClassName` after the change (grep-level assertion in a unit or CI check).
  - A representative delete-confirm dialog renders its confirm button with the destructive variant styling (data-slot/variant assertion).
  - Existing delete-dialog behavior tests still pass (the button still fires its handler).
- **Verification:** `destructiveActionClassName` is gone; 18 sites use the variant; delete flows behave as before.

---

## Verification Contract

- `pnpm --filter web test --run` — full suite green (baseline is 0 failures on a correctly-set-up tree; see `local/LOCAL_SETUP.md` §3.15 if tests appear broken — that is an environment, not a code, signal).
- `pnpm --filter web type-check` — no new errors.
- `pnpm exec biome check` on every changed file — clean.
- Targeted: `pnpm --filter web test --run modules/ui/components/__tests__/ ImageSelectionToolbar NavBar` covers U2, U5, U6.
- Optional real-browser pass on staging (Playwright MCP): a flagged truncation button (U4) opens its tooltip on hover; a collapsed disabled nav row (U2) has an accessible name.

## Definition of Done

- R1–R6 satisfied; each unit's test scenarios pass.
- `destructiveActionClassName` removed with zero remaining references.
- No native `title` on the image-toolbar buttons; `aria-label`s intact; standard updated.
- No WCAG 2.5.3 regression introduced by any new `aria-label`.
- A `.changeset/*.md` with `"fabric-app": patch` describing the follow-ups.
- Full suite, type-check, and biome green. User owns commit/push/PR.

---

## Outstanding questions

- **U1 treatment (non-blocking):** drop `cursor-pointer` (default, planned) versus wiring the marker to a real action (scroll-to / open the source). Default to dropping unless a product reason to make it actionable surfaces during implementation.

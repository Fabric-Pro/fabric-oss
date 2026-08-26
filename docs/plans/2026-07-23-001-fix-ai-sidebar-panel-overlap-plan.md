---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
type: fix
title: "fix: AI assistant panel overlaps editor in 640-767px band"
date: 2026-07-23
branch: fix/ai-feature-assistant-panel-overlap
status: implementation-ready
---

# fix: AI Assistant Panel Overlaps Editor in the 640–767px Band — Plan

## Summary

The AI Feature Assistant (a CopilotKit `<CopilotSidebar>`) docks as a fixed, 28rem-wide right rail at viewport width **≥640px**, but the editor page-chrome only reserves space for it at Tailwind **`md:` (≥768px)**. In the **640–767px** band the editor spans full width *under* the docked panel, producing a measured **448px overlap** (verified live on staging). The same page-chrome pattern is copy-pasted across **three** host pages, so all three have the bug. Fix: reserve at `sm:` (640px) instead of `md:`, matching CopilotKit's dock breakpoint, and route the three copies through one shared constant so the breakpoint cannot drift out of sync again.

---

## Problem Frame

**Symptom (reported):** the AI Feature Assistant window overlaps and creeps into the feature editor content area.

**Root cause (verified on the staging host via Playwright, story detail page):** a CSS breakpoint mismatch — not z-index, not positioning, not the detection logic.

- Vendor CSS (`@copilotkit/react-ui@1.52.0`) docks the panel `position: fixed; width: 28rem` at `@media (min-width: 640px)`.
- Fabric cancels CopilotKit's own space-reservation margin **unconditionally** — [globals.css:1291-1293](apps/web/app/globals.css#L1291) sets `.copilotKitSidebarContentWrapper.sidebarExpanded { margin-right: 0 !important; }` (no media query).
- Fabric instead reserves editor space on the fixed page-chrome wrapper via `md:right-[28rem]`, gated on `isAiSidebarExpanded` — but `md:` = 768px.
- **Gap:** 640–767px → panel docked (28rem) while chrome stays `right-0` → editor renders full-width under the panel.

**Measured on staging (F-004 story, panel open):**

| Viewport | Panel | Chrome right edge | Overlap |
|---|---|---|---|
| 500px | full-width overlay (mobile) | 485 | intended overlay |
| 720px | docked, left=257 w=448 | 705 | **448px** |
| 767px | docked, left=304 w=448 | 752 | **448px** |
| 768px | docked, left=305 w=448 | 305 | **0px** ✅ |

The `isAiSidebarExpanded` MutationObserver ([StoryWorkspacePage.tsx:211-231](apps/web/modules/saas/projects/components/stories/StoryWorkspacePage.tsx#L211)) was measured working correctly (`sidebarExpanded` present, state `true`), confirming this is purely the breakpoint gap.

---

## Requirements

- **R1** — The docked AI assistant panel must not overlap the editor content at any viewport ≥640px where the panel is a fixed 28rem rail (i.e., 640–767px overlap must go to 0, and ≥768px must stay at 0).
- **R2** — The fix must cover **every** page that hosts the CopilotKit sidebar with this reservation pattern, not only the reported story page.
- **R3** — Mobile behavior (<640px, full-screen overlay) and desktop behavior (≥768px, already correct) must be unchanged.
- **R4** — Prevent recurrence: the reservation breakpoint should live in one place, so the three host pages cannot drift apart again.

---

## Key Technical Decisions

**KTD1 — Change the reservation breakpoint from `md:` (768px) to `sm:` (640px).**
Tailwind v4.1.16 with no config/`@theme` override → default `sm` = 640px, which is exactly CopilotKit's `@media (min-width: 640px)` dock point. Aligning them closes the 640–767px gap and leaves the ≥768px behavior identical (the panel width is a constant 28rem across all these widths, and reserving `right-[28rem]` already yields 0 overlap at 768px — the fix just makes that same reservation begin 128px earlier). Rationale is empirical: 768px measured 0 overlap; the panel is unchanged 28rem down to 640px.

**KTD2 — Leave `md:left-[72px]` unchanged.** The 72px left nav rail is independently `md`-gated and is hidden below 768px (confirmed: the 720px screenshot shows content flush at x=0, no rail). Only the right-edge reservation is mis-breakpointed. Touching the left edge would be scope creep and risk a left-side regression.

**KTD3 — De-duplicate the reservation fragment into one shared constant.** The identical `${isAiSidebarExpanded ? "md:right-[28rem]" : ""}` fragment is copy-pasted in three page-chrome wrappers. That triplication is the drift risk that let the bug exist. Export a single `AI_SIDEBAR_CONTENT_SHIFT_CLASS = "sm:right-[28rem]"` and reference it from all three. The three wrappers' *base* classes differ slightly (`document-generator` lacks `flex flex-col`), so only the reservation fragment is shared, not the whole className.
*Alternative considered:* edit the three inline strings without extracting. Rejected — it fixes the symptom but preserves the drift risk R4 targets. (The minimal inline edit remains a valid fallback if Tailwind JIT detection of the extracted constant proves problematic — see U1 verification.)

**KTD4 — Failure mode B (detection fragility) is out of scope.** The overlap can also occur if `isAiSidebarExpanded` reads `false` while the panel is docked, because the MutationObserver keys on literal CopilotKit class strings (`.copilotKitSidebarContentWrapper`, `sidebarExpanded`) that a version bump could rename. It is not the reported bug and was measured working. Note it as deferred hardening; do not fix it here.

---

## Implementation Units

### U1. Correct the reservation breakpoint across all three host pages via a shared constant

**Goal:** Close the 640–767px overlap on every CopilotKit sidebar host by reserving at `sm:` instead of `md:`, sourced from one shared constant. (R1, R2, R4; KTD1, KTD3)

**Dependencies:** none.

**Files:**
- `apps/web/modules/saas/projects/components/copilot/ai-sidebar-layout.ts` — **new.** Exports `AI_SIDEBAR_CONTENT_SHIFT_CLASS = "sm:right-[28rem]"` with a short comment linking the value to CopilotKit's 640px dock media query (so the *why* travels with the constant).
- `apps/web/modules/saas/projects/components/stories/StoryWorkspacePage.tsx` — replace inline `"md:right-[28rem]"` at [line 368](apps/web/modules/saas/projects/components/stories/StoryWorkspacePage.tsx#L368) with the imported constant.
- `apps/web/modules/saas/projects/components/DocumentEditorPage.tsx` — replace inline `"md:right-[28rem]"` at [line 357](apps/web/modules/saas/projects/components/DocumentEditorPage.tsx#L357).
- `apps/web/app/(saas)/app/agents/document-generator/page.tsx` — replace inline `"md:right-[28rem]"` at [line 131](apps/web/app/(saas)/app/agents/document-generator/page.tsx#L131).
- Update the explanatory comment at [globals.css:1279-1280](apps/web/app/globals.css#L1279) which still says `md:right-[28rem]` → `sm:right-[28rem]`.

**Approach:** Each wrapper keeps its own base classes and its `isAiSidebarExpanded ? SHIFT : ""` ternary; only the literal fragment moves to the constant. Import path for `document-generator/page.tsx` crosses into `modules/saas/projects/components/copilot/` — acceptable (already a shared copilot util location).

**Patterns to follow:** existing shared constants under `apps/web/modules/saas/projects/components/copilot/`.

**Test scenarios:** behavioral verification is DOM/visual (see Verification) — not unit-testable inside these provider-heavy pages. Drift protection is U2.
- Test expectation: none in this unit — the invariant it establishes is asserted in U2 against the exported constant; runtime behavior is proven in Verification.

**Verification (per-unit):**
- Grep confirms **zero** remaining `md:right-[28rem]` occurrences in `apps/web` (including the globals.css comment).
- After the extraction, confirm Tailwind still emits the `sm:right-[28rem]` utility (JIT scans `.ts` source, so the constant literal is detected) — check computed style / generated CSS on the running page, or the DOM-injection proof in Verification. If the utility is somehow not emitted, fall back to the inline `sm:` edit per KTD3.

### U2. Add a regression guard on the reservation breakpoint

**Goal:** Encode the CopilotKit-dock coupling so a future edit back to `md:` (or any non-`sm` breakpoint) fails a test. (R4)

**Dependencies:** U1.

**Files:**
- `apps/web/__tests__/modules/saas/projects/ai-sidebar-layout.test.ts` — **new.**

**Approach:** Import `AI_SIDEBAR_CONTENT_SHIFT_CLASS` and assert it targets the `sm:` breakpoint (640px, matching CopilotKit's dock) and reserves `right-[28rem]`. Assert it does **not** start with `md:`/`lg:`/`xl:`. Keep it a small, intent-documenting guard — its job is to break loudly if the breakpoint regresses, with a comment explaining *why* `sm` (640px = CopilotKit dock).

**Test scenarios:**
- Happy path: constant equals `"sm:right-[28rem]"` → passes.
- Regression guard: constant does not begin with `md:`/`lg:`/`xl:` (the exact class of regression that caused this bug) → asserts.
- The test body carries a one-line comment pointing to CopilotKit's `@media (min-width: 640px)` dock rule so the reason survives.

**Verification (per-unit):** `pnpm --filter web test __tests__/modules/saas/projects/ai-sidebar-layout.test.ts` passes.

### U3. Changeset

**Goal:** Record the user-facing fix for release. (repo convention)

**Dependencies:** U1.

**Files:**
- `.changeset/<generated-name>.md` — **new.**

**Approach:** Frontmatter bumps **only** `"fabric-app": patch` (never internal `@repo/*`). Body line 1 is the CHANGELOG headline, e.g.: `Fixed the AI assistant panel overlapping the editor on medium-width screens (640–767px).` Blank line, then internal context (root cause: `md:`→`sm:` breakpoint mismatch vs CopilotKit's 640px dock; all three CopilotSidebar host pages).

**Test scenarios:** Test expectation: none — release metadata.

**Verification (per-unit):** file exists with non-empty frontmatter declaring `fabric-app: patch`.

---

## Verification

**Executable in this session (DOM-level proof on staging, no deploy needed).** On the staging story page at 720px, the fix's effect is provable by applying the reservation directly and re-measuring:
1. Resize to 720px, panel open.
2. Set the page-chrome wrapper's `style.right = "28rem"` (simulating what `sm:right-[28rem]` will do at that width).
3. Re-measure: chrome right edge should meet the panel's left edge and `overlap` should drop from 448px to **0** — the same clean state measured natively at 768px.
This proves the geometry; the fix simply makes Tailwind apply that reservation from 640px up.

**Regression reasoning (deterministic):** panel width is a constant 28rem for all widths ≥640px; 768px already measured 0 overlap with the identical `right-[28rem]` reservation; therefore applying it from 640px yields 0 overlap across 640–767px without affecting ≥768px.

**Post-implementation (local or post-deploy staging) — full sweep:** with the fix running, confirm overlap = 0 at **640 / 720 / 767 / 768 / 1440px**, the panel closes/opens cleanly, and **<640px** still shows the intended full-screen mobile overlay. Repeat the panel-open check on the **AI Document Assistant** (document editor page) and the **Document Generator** agent page (R2).

**Automated:** U2 guard test passes; `pnpm --filter web type-check` and `pnpm lint`/Biome clean on the touched files.

---

## Scope Boundaries

**In scope:** the right-edge reservation breakpoint on all three CopilotKit sidebar host pages; one shared constant; a guard test; a changeset.

**Deferred to Follow-Up Work:**
- **Failure mode B — detection fragility (KTD4).** Harden `isAiSidebarExpanded` against CopilotKit class-name changes (e.g., a resilience test that fails if the pinned `@copilotkit/react-ui` version renames `sidebarExpanded`/`copilotKitSidebarContentWrapper`). Separate concern, currently working.
- Consolidating the *entire* page-chrome wrapper (not just the shift fragment) into one shared component — larger refactor; the `/ce-simplify-code` pass can evaluate it.

**Out of scope:** `md:left-[72px]` left-rail behavior (KTD2); any CopilotKit theme/token CSS.

---

## Risks & Dependencies

- **Tailwind JIT detection of the extracted constant (low).** Tailwind v4 scans `.ts` source and detects the complete `sm:right-[28rem]` token, but the constant introduces one indirection. Mitigation: U1 verification confirms the utility is emitted; inline `sm:` edit is the fallback (KTD3).
- **Cross-module import (negligible).** `document-generator/page.tsx` importing from `modules/saas/projects/components/copilot/` is consistent with existing shared-copilot usage.
- No data, API, auth, or migration surface. UI-CSS only.

---
title: AI assistant sidebar overlaps the editor (CopilotKit dock vs page-chrome reservation)
date: 2026-07-23
last_updated: 2026-07-28
category: ui-bugs
module: apps/web AI assistant sidebar host pages
problem_type: ui_bug
component: assistant
symptoms:
  - AI Feature Assistant panel overlaps and covers the feature editor at ~640-767px viewport width
  - Editor content renders full-width underneath the docked 28rem chat panel
  - Task Planner agent page overlaps at every width >=640px
  - "Masthead rows (breadcrumb, action bar, tabs) still spill under the panel at narrow widths (<~1100px) even after the reservation fix"
root_cause: config_error
resolution_type: code_fix
severity: medium
related_components:
  - copilotkit
  - tailwind
tags:
  - copilotkit
  - copilot-sidebar
  - tailwind
  - responsive
  - breakpoint
  - overlap
---

# AI assistant sidebar overlaps the editor (CopilotKit dock vs page-chrome reservation)

## Problem
The AI assistant panel (a CopilotKit `<CopilotSidebar>`) overlapped the editor content on the feature/story editor. Root cause was a Tailwind breakpoint mismatch between where CopilotKit docks the panel and where the page reserved space for it.

## Symptoms
- At 640-767px viewport width, the editor spanned full-width under the docked 28rem panel (measured 448px overlap on staging).
- The Task Planner agent page overlapped at *every* width >=640px.

## What Didn't Work
- Looking for a z-index or `position` bug — the panel positioning was correct; the editor simply never reserved space in the affected band.
- Grepping only for `md:right-[28rem]` — this found 3 of the 4 host pages and missed `task-planner/page.tsx`, which had *no* reservation at all.

## Solution
CopilotKit docks the sidebar as `position: fixed; width: 28rem` at `@media (min-width: 640px)`. Fabric cancels CopilotKit's own content-wrapper margin **unconditionally** in `apps/web/app/globals.css` (`.copilotKitSidebarContentWrapper.sidebarExpanded { margin-right: 0 !important; }`), so **each host page must reserve editor space itself** on its fixed page-chrome wrapper, gated on the shared `useAiSidebarExpanded()` hook (a MutationObserver that watches for CopilotKit's `sidebarExpanded` class).

The reservation breakpoint must match CopilotKit's dock breakpoint — `sm` (640px), not `md` (768px). The value now lives in one shared constant:

```ts
// apps/web/modules/saas/shared/components/copilot/ai-sidebar-layout.ts
export const AI_SIDEBAR_CONTENT_SHIFT_CLASS = "sm:right-[28rem]";
```

The same module also exports the detection hook, so both halves of the mechanism live in one place:

```tsx
// pass `true` on pages whose <CopilotSidebar> mounts with defaultOpen
const isAiSidebarExpanded = useAiSidebarExpanded(/* defaultExpanded */ true);
// ...
className={`fixed inset-y-0 left-0 right-0 md:left-[72px] bg-background transition-[right] duration-300 ${
  isAiSidebarExpanded ? AI_SIDEBAR_CONTENT_SHIFT_CLASS : ""
}`}
```

Four host pages must stay in sync: `StoryWorkspacePage.tsx`, `DocumentEditorPage.tsx`, `app/(saas)/app/agents/document-generator/page.tsx`, and `app/(saas)/app/agents/task-planner/page.tsx`. `task-planner` additionally needed the whole reservation machinery added because it never had it.

## Why This Works
`sm` = `min-width: 640px` is a superset of `md`'s 768px, so at >=768px the computed `right: 28rem` is unchanged (no regression), and the 640-767px gap now reserves the 28rem the panel occupies. Below 640px neither prefix applies and the panel is a full-screen mobile overlay (intended). The `sm` boundary coincides exactly with CopilotKit's `@media (min-width: 640px)` dock point, so there is no off-by-one gap. Tailwind v4 auto-detects the complete static literal `"sm:right-[28rem]"` in the `.ts` constant, so the utility is still generated.

## Second cause: masthead rows overflow under the panel (even with a correct reservation)

The reservation fix above shifts the editor's *body*, but the page-chrome **masthead** is a stack of horizontal `flex` rows (Line 1 title, Line 2 breadcrumb, Line 3 action bar, plus the maturation tab bar and the "Update Full Spec / Change to bug" toolbar on the story editor). Those rows have `min-width: auto` and `overflow: visible` by default, so when the reserved column is narrower than their content — any viewport below ~1100px, worst in the 640-767px band — they **overflow horizontally under the panel** even though the body reserves space correctly. It's most visible on a story/document with a full action bar. This is a distinct root cause from the breakpoint mismatch (that one is the body not reserving; this one is the chrome not fitting the reserved column).

Fix: add `min-w-0 overflow-x-auto` to each overflowing masthead/toolbar row so it scrolls horizontally *within* the editor column instead of spilling under the panel (matching the app's existing scroll-tab pattern; no scrollbar appears at wide widths where content fits). The title row already truncates via `min-w-0`; the TipTap formatting toolbar wraps on its own — neither needs the fix.

Rows fixed:
- Story editor — `StoryWorkspacePage.tsx` (breadcrumb + action bar) and `StoryWorkspace.tsx` (the "Update Full Spec / Change to bug" toolbar + the maturation tab-bar `<Tabs>` container).
- Document editor — `DocumentEditorPage.tsx` (breadcrumb + action bar). Its "Update Binding" row uses `justify-between` and shrinks, so it does not overflow.

Safe because `overflow-x: auto` forces `overflow-y: auto`, which would clip *in-DOM* popovers — but every action-bar control (Tooltip, Popover, DropdownMenu, Select) is Radix-**portaled to `body`**, so nothing downward-opening is a DOM child of the row. Verified on staging (both editors, 1024 + 767px) with a clipping-aware visible-overlap scan returning zero elements under the panel. Reported via Fizzy #2025.

## Prevention
- Keep the reservation breakpoint in the shared `AI_SIDEBAR_CONTENT_SHIFT_CLASS` constant — never inline `md:right-[28rem]` per page (that triplicated string is what let the breakpoints drift).
- A guard test pins the breakpoint: `apps/web/__tests__/copilot/ai-sidebar-layout.test.ts` asserts the constant is `sm:right-[28rem]` and does not regress to a larger prefix.
- **When adding a new `<CopilotSidebar>` host page, it must carry the full reservation pattern**: `const isAiSidebarExpanded = useAiSidebarExpanded()` (pass `true` if the panel mounts `defaultOpen`), plus `transition-[right] duration-300` and `${isAiSidebarExpanded ? AI_SIDEBAR_CONTENT_SHIFT_CLASS : ""}` on the fixed page-chrome wrapper. Both the hook and the class live in `ai-sidebar-layout.ts`. Search by `CopilotSidebar` usage, not by the reservation class, so hosts that lack the reservation entirely are not missed.
- Verify overlap = 0 at 640 / 720 / 767 / 768px; the unconditional `!important` margin cancel in `globals.css` means any host without its own reservation overlaps at all widths >=640px.
- **Also check the masthead**, not just the body: a host can reserve space correctly yet still overflow its breadcrumb/action-bar/toolbar rows under the panel (see "Second cause" above). Any non-shrinking `flex` masthead row inside the reserved column needs `min-w-0 overflow-x-auto`. Verify with a clipping-aware scan (walk the editor chrome, compute each element's right edge after clipping ancestors, assert none exceed the panel's left edge) at 1024 + 767px — a naive `getBoundingClientRect().right` check gives false positives once `overflow-x-auto` clips the content.

## Related Issues
- Breakpoint fix plan: `docs/plans/2026-07-23-001-fix-ai-sidebar-panel-overlap-plan.md`
- Document editor masthead plan: `docs/plans/2026-07-28-001-fix-document-editor-masthead-overflow-plan.md`
- Fizzy #2025

---
title: "Moving a floating element into normal flow: spacing lands on a wrapper, and a lone warning must stay visible"
date: 2026-07-17
category: design-patterns
module: web app shell — build-update banner
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Un-floating a component — removing `fixed`/`absolute` so it reserves layout space instead of covering content"
  - "Adding spacing to a shadcn/cva primitive (Alert, Card, Badge) that already sets its own padding"
  - "Placing a transient warning that precedes an irreversible action (reload, navigation, session end)"
  - "Copying a layout pattern from a sibling component that looks structurally similar"
tags: [tailwind, twmerge, cva, layout, sticky, in-flow, shadcn, alert, jsdom, verification]
related_components: [documentation]
---

# Moving a floating element into normal flow: spacing lands on a wrapper, and a lone warning must stay visible

## Context

The build-update banner ("A new version of Fabric is available") rendered as a `fixed inset-x-0 top-0 z-[200]` overlay. It covered the project header, and because the container spanned the full viewport width with no pointer-events handling, the whole top strip swallowed clicks.

The fix looked trivial: the component was already mounted in the right place, so removing the `fixed` wrapper would drop it into normal flow. Both traps below were found by review, not by the author, and the first draft shipped one of them.

## Guidance

**1. Spacing utilities go on a wrapper, never on a primitive whose cva already owns padding.**

`Alert`'s cva base includes `p-4`, and `cn` is `twMerge(clsx(...))`. Passing `pt-3 pb-1` through the primitive's `className` does not add outer spacing — it silently shrinks the primitive's own padding. `twMerge` keeps all three (`pt` is a *child* group of `p`, so `p-4` is not stripped), and Tailwind emits `pt-*`/`pb-*` after `p-*` in the stylesheet, so the child utilities win the cascade. Result: 12px top / 4px bottom against 16px sides.

When you copy a spacing pattern from a sibling component, check *which node* carries the classes. Here the sibling's `pt-3 pb-1` sat on a plain wrapper `<div>` with no padding of its own. The transferable half of the pattern was the wrapper, not the class string — and the first draft deleted exactly that wrapper while keeping the classes.

**2. A transient warning that precedes an irreversible action must be `sticky`, not static.**

Static flow puts the element at the top of its container. If the window scrolls, a user scrolled away from the top never sees it. That is fatal when the element is the *only* warning before something irreversible — the action still fires on its timer, so the user gets the consequence without the warning.

`sticky top-0` still occupies its flow space, so it reserves height and pushes content down exactly as static flow would. It just does not scroll away.

Watch for the inverted argument: **browser scroll anchoring makes this worse, not better.** Scroll anchoring keeps the reading position stable when content is inserted above — which is why it removes the only visual cue that anything appeared. It had been cited as a mitigation for the layout jump; it is, and that is precisely the problem.

**3. Verify at the position where the bug occurs, not where it doesn't.**

The staging check measured geometry at scroll-top and on a full-height route. Both are exactly the cases that do *not* exercise a scroll-visibility bug. Clean numbers from the wrong position read as proof and are not.

## Why This Matters

Trap 1 is cosmetic but invisible to the whole test layer: jsdom computes no CSS, so nothing in the suite can see a collapsed padding box. It reaches a human only as "that looks a bit cramped."

Trap 2 is the serious one. The banner fires only after ten minutes on a stale build with no navigation seam — which means it fires on someone parked on one screen, reading, almost certainly scrolled down. The failure case *is* the primary case: the user sees nothing, and the page force-reloads under them sixty seconds later. Measured on staging at `scrollY: 504`, the static banner sat at `top: -492` (entirely outside the viewport); sticky sat at `top: 12`.

Class-token assertions cannot catch either one. The same assertions pass against both the broken and the fixed version.

## When to Apply

- Removing `fixed` or `absolute` from anything, so it reserves space rather than overlays.
- Passing `p-*`, `px-*`, `py-*`, `pt-*`, `pb-*` into a shadcn/cva primitive's `className` — check the primitive's base classes first. If it owns padding, use margin, or put the spacing on a wrapper.
- Placing any transient notice whose disappearance costs the user something: pre-reload warnings, unsaved-work prompts, countdowns, session-expiry notices.
- Reviewing a "just delete the wrapper" or "just remove the positioning" diff — the wrapper is often load-bearing for reasons the diff does not show.

## Examples

**Trap 1 — spacing on the primitive vs. on a wrapper**

```tsx
// WRONG — `pt-3 pb-1` fights the Alert's own `p-4` and wins.
// Computed padding: 12px top / 16px sides / 4px bottom. No outer gap at all.
<Alert variant="primary" className="pt-3 pb-1 flex max-w-2xl items-center gap-3">

// RIGHT — the wrapper has no padding of its own, so the classes mean what they say.
// The Alert's own `p-4` survives intact (verified: 16px computed).
<div className="flex justify-center px-3 pt-3 pb-1">
  <Alert variant="primary" className="flex max-w-2xl items-center gap-3">
```

**Trap 2 — static vs. sticky for a lone warning**

```tsx
// WRONG — in flow, but pinned to the top of the document. A scrolled user
// never sees it, and the reload still fires on schedule.
<div className="flex shrink-0 justify-center px-3 pt-3 pb-1">

// RIGHT — still occupies flow space (content is pushed down, not covered),
// but stays visible once the user scrolls.
<div className="sticky top-0 z-10 flex shrink-0 justify-center px-3 pt-3 pb-1">
```

**A corollary worth internalising:** the readability half of the original bug needed no fix at all. The `Alert` `primary` variant is a 10% tint designed to composite against the page background; floated over the header it composited with the header's text instead. Once in flow it reads correctly with no opacity override — and the click-blocking strip has nothing left to stand on either. Both defects were consequences of the overlay, not of the variant. Removing the cause beat patching two symptoms.

## Related

- `CONCEPTS.md` → *Build updates* — defines `Reload Seam` and `Backstop banner`, the vocabulary this learning depends on.
- `docs/solutions/best-practices/search-input-browser-autofill-hardening.md` — the other "shared UI primitive behaves unexpectedly at a call site" learning.

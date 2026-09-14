---
title: "One region owns the notice stack: a parent cannot see a null child, and the class decides the placement"
date: 2026-09-14
category: design-patterns
module: web app shell — global notices
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Adding a global banner, notice, or nudge to the app shell"
  - "Deciding whether a notice should float or sit in flow"
  - "Writing a wrapper that must disappear when it has nothing to wrap"
  - "Hand-writing a sidebar offset, or any measurement another component owns"
  - "Publishing a rule into a strict specification while known violators ship"
tags: [layout, z-index, stacking, react, null-children, banners, flow, sidebar, jsdom]
related_components: [documentation]
---

# One region owns the notice stack: a parent cannot see a null child, and the class decides the placement

## Context

Four global notices had grown up in three unrelated mount points, each choosing its own CSS position and z-index at its own call site. Nothing ordered them, nothing spaced them, and the sidebar offset that keeps them clear of the navigation was written out four times across two files in two different encodings with two different gutters (`md:left-[72px]` + `px-4` against `md:left-[96px]`, which is the same 72px with a 24px gutter baked in).

The reported bug was two banners overlapping on the dashboard. By the time it was picked up, an unrelated design-system pass had already separated that specific pair — but the security banner was still a `fixed top-4 … z-50` overlay that reserved no height, so it covered the page heading, and below `md`, where `NavBar` is static and full-width, it sat directly on the navigation.

## Guidance

**1. The notice's class decides its placement, not its author's taste.**

Two classes, and this repo already had both before either was named:

- A **shell notice** reserves its own height and is never a viewport overlay. It goes in flow.
- An **advisory notice** reports a standing configuration state, is dismissible, and floats.

The distinction is not cosmetic — it is what makes the placement argument decidable. `docs/solutions/design-patterns/moving-a-floating-element-into-normal-flow.md` requires `sticky` for a notice "whose disappearance costs the user something", and scopes that rule to pre-reload warnings, unsaved-work prompts, countdowns and session-expiry notices. A seven-day-snoozable security nudge is not in that set, so it takes static flow; the pre-reload Backstop banner is, so it stays sticky. Both are shell notices; only one needs to survive a scroll.

Define the class as **"reserves its own height and is never a viewport overlay"**, not "never covers content". A sticky notice does pass over content once the user scrolls — what it never does is fail to reserve its height. The looser wording excludes the class's own oldest member.

**2. A React parent cannot observe that a child returned null.**

`<div className="flex flex-col gap-3"><Notice /></div>` mounts the div whether or not `Notice` renders anything. "The wrapper disappears when its children do" is not a thing React offers, and a plan that says so hands the implementer an unsolved problem disguised as a detail.

Lift each member's gate into an exported hook the region calls *before* it decides to render:

```tsx
export function useMfaNoticeVisible(): boolean { /* the member's own gates */ }

export function ShellNoticeRegion() {
	const securityVisible = useMfaNoticeVisible();   // asked before rendering
	const notices = securityVisible ? [{ id: "security", node: <MfaSetupBanner /> }] : [];
	return <ShellNoticeStack notices={notices} />;   // renders null when empty
}
```

The member still calls its own hook, so the two cannot disagree about whether the notice exists. Every query involved is cache-backed, so the second call is a cache hit.

**3. An in-flow element cannot cover a sibling — but that is the wrong direction.**

The risk to a shell notice is being *covered*, not covering. Four route families paint their own `fixed inset-y-0` chrome over the whole viewport, ignoring the content column entirely; an in-flow notice there renders behind them. So the rule is **"no z-index, and yield where you cannot win"** — not "layering does not apply". Publishing the shorter version into a strict specification teaches the next author to add a notice with no z-index on an editor route and get an invisible element with no diagnostic to point at.

The no-z-index conclusion also depends on no ancestor of the mount point establishing a stacking context (`transform`, `filter`, `backdrop-filter`, `will-change`). True here; nothing pins it.

**4. Do not enumerate a route set by reaching for the predicate that already exists.**

`AppWrapper` computes `isFullHeightRoute` — the workflow canvas, `/chatbot`, `/nexus`, kanban. Those own their own scrolling but stay inside the content column, so an in-flow notice is perfectly visible on them. It is a plausible-looking, entirely disjoint set from the full-bleed routes. Reusing it would have hidden the notice on the four routes where it works and left it invisible on the six where it does not. Two predicates that sound alike need a test that asserts each rejects the other's members.

**5. A strict spec must name its known violators on the day it lands.**

`docs/ui-style-guide.md` declares itself a specification, not guidance, and had no layering section at all. Publishing a ladder that tops out at 200 while shipping code sits four orders of magnitude above it leaves the next reader unable to tell which is authoritative — the exact ambiguity the ladder exists to remove. List the exceptions and say they are ticketed.

## Why This Matters

The reported overlap was already gone, and it would have been easy to close the ticket as stale. The defect underneath it was not: the banner covered the navigation at phone width on every load, and nothing in the suite could see it.

Nothing in the suite can see any of this. jsdom compiles no CSS — `getComputedStyle` does not resolve `var()`, `getBoundingClientRect` returns zeros — so overlap, spacing and stacking are all invisible to unit tests. What unit tests *can* prove is membership, DOM order, the empty case, and aria wiring. Geometry needs a browser, measured at a scrolled position.

The counting errors are worth noting too. "Four routes" was six. "Eight page wrappers" was nine occurrences across five files, plus a sixth file nobody had listed. Every one of those was a number written from memory during planning rather than grepped, and each would have become a gap in the implementation.

## When to Apply

- Adding any global notice to the app shell — pick the class first, then the placement follows.
- Writing a container that must vanish when empty: decide membership before rendering, never after.
- Reusing an existing route predicate for a new purpose — check what it actually matches, and test that it rejects the other set.
- Writing a measurement a different component owns: import it, and pin it with a guard test that reads the owner's source.
- Publishing a rule into a document that calls itself mandatory.

## Examples

**Membership decided before render, not after**

```tsx
// WRONG — the wrapper mounts (and spaces, and pads) even when the child is null.
<div className="flex flex-col gap-3 pt-4">
	<MfaSetupBanner />
</div>

// RIGHT — the region asks first, and renders nothing at all when the answer is no.
const notices = securityVisible ? [{ id: "security", node: <MfaSetupBanner /> }] : [];
if (notices.length === 0) return null;
```

**The offset lives with its owner**

```tsx
// WRONG — the fourth hand-written copy of NavBar's width, with a different
// gutter baked in than the one next to it.
isCollapsed ? "md:left-[96px]" : "md:left-[256px]"

// RIGHT — one module, pinned to NavBar by a test that reads NavBar's source.
shellDockOffsetClass(isCollapsed)
```

## Related

- `docs/solutions/design-patterns/moving-a-floating-element-into-normal-flow.md` — the same shell, un-floated in the other direction; source of the sticky-vs-static rule this one scopes, and of the wrapper-spacing trap.
- `docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md` — the earlier hand-written-offset drift, and the shared-constant-plus-guard-test remedy copied here.
- `docs/solutions/conventions/the-nth-special-case-means-generalize.md` — why three ad-hoc placements is the trigger, and why the fix is measured in unreported instances closed.
- `docs/solutions/conventions/a-comment-that-overclaims-a-guarantee-disables-vigilance.md` — why the `AppWrapper` comment was softened to an open observation rather than swapped for a new confident claim.
- `CONCEPTS.md` → *Shell notice region*, *Advisory dock*, *Backstop banner*.

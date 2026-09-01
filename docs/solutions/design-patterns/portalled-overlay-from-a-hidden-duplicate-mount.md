---
title: "A portalled overlay ignores its ancestor's display:none — responsive duplicate mounts open one from nowhere"
date: 2026-07-30
category: design-patterns
module: apps/web sidebar navigation — Get started launcher pointer
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Attaching a Popover, Tooltip, Dropdown, or any portalled overlay to a trigger that the layout renders more than once"
  - "A component is mounted at every viewport width and hidden with a responsive utility (`hidden md:flex`) rather than conditionally rendered"
  - "Auto-opening an overlay from an effect instead of from a user click on the trigger"
  - "Writing jsdom tests for code that branches on element visibility"
tags: [radix, popover, portal, responsive, visibility, jsdom, checkvisibility, onboarding]
related_components: [documentation]
---

# A portalled overlay ignores its ancestor's display:none — responsive duplicate mounts open one from nowhere

## Context

The Get started launcher (Fizzy #2103) needed a callout anchored to its sidebar entry. The entry is rendered through one shared component, so attaching a Radix `Popover` to it looked like a one-line composition problem.

Two facts about the navigation made it not one:

1. The sidebar renders the account-utility rows **twice** — once in the mobile `Sheet` and once in the desktop rail.
2. The desktop rail is not conditionally rendered. It stays mounted at every viewport width and hides below the `md` breakpoint with a CSS utility:

   ```tsx
   <div className="no-scrollbar mt-4 hidden flex-1 flex-col gap-5 overflow-y-auto pb-4 md:flex">
   ```

So on any phone-width viewport, a mounted-but-invisible copy of the launcher exists, its effects run, and it is perfectly happy to open a popover. The callout was auto-opened from an effect rather than a click, so nothing about the user's behaviour prevented it.

This was caught in review, not by the author, and not by any test — every test passed.

## Guidance

**1. A portalled overlay does not inherit an ancestor's `display:none`.**

`PopoverContent` renders inside `PopoverPrimitive.Portal`, which reparents it to `document.body`. The `hidden` class sits on an ancestor of the *anchor*, not of the *content*, so it never applies. The anchor inside a `display:none` subtree has no box, `getBoundingClientRect()` returns all zeros, and the positioner places the content at the viewport origin: a callout floating in the top-left corner, pointing at nothing.

The rule generalizes past Radix — anything portalled (tooltips, dropdowns, dialogs, custom `createPortal` overlays) is outside the trigger's containing block and outside its visibility cascade.

**2. Gate on `Element.checkVisibility()`, not on a rect or `offsetParent`.**

`checkVisibility()` is the only DOM API that reports whether an element is rendered accounting for `display:none` on *any* ancestor. The alternatives are traps:

- `getBoundingClientRect()` returning zeros also happens for a legitimately zero-size element and cannot distinguish "hidden" from "not laid out yet."
- `offsetParent === null` is the classic idiom but reports `null` for `position: fixed` elements that are perfectly visible.

```ts
function isAnchorOnScreen(el: HTMLElement | null): boolean {
	if (!el) {
		return false;
	}
	return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}
```

**3. Whichever copy is visible must also claim the shared "already shown" flag.**

Suppressing the hidden copy is only half of it. If the hidden copy writes the once-per-session flag before bailing out, the visible copy is silenced too and the user sees nothing at all. Check visibility *before* claiming the flag, not after.

**4. jsdom does not implement `checkVisibility`, so the fallback direction is load-bearing.**

jsdom has no layout engine and the property is simply absent. The fallback above returns `true` when the API is missing — deliberately. Reverse it and every popover test silently passes while asserting on a popover that never opened, which is exactly the class of green-but-meaningless test this guidance exists to prevent.

Because the property is absent rather than present-and-wrong, `vi.spyOn` cannot stub it:

```
Error: The property "checkVisibility" is not defined on the object.
```

Define it instead, and clean up after:

```ts
Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
	value: () => false,
	configurable: true,
	writable: true,
});
// ... assert the overlay stayed closed ...
delete (HTMLElement.prototype as Partial<HTMLElement>).checkVisibility;
```

## Why This Matters

The failure is invisible in every place a developer normally looks. The component tree is correct, the props are correct, the tests are green, and a desktop browser — where the hidden copy does not exist — shows nothing wrong. It surfaces only on a real narrow viewport, as an overlay with no apparent origin, which reads as a rendering glitch rather than a logic error and is correspondingly hard to trace back.

The responsive-duplicate-mount pattern (`hidden md:flex` on a mounted subtree) is common and mostly harmless, because a hidden element that only reacts to clicks is inert. It stops being harmless the moment the element gains an effect that fires on its own or an overlay that escapes the DOM.

## When to Apply

- Any overlay primitive with a portal, attached to a trigger that appears in more than one responsive branch.
- Any effect-driven, auto-opening UI (onboarding nudges, first-run callouts, notification popovers) — a click-driven overlay is naturally protected because a hidden element cannot be clicked.
- Any time responsive variants are handled by CSS hiding rather than conditional rendering. Conditional rendering (`useMediaQuery`) dodges the whole class of bug, at the cost of an SSR-hydration mismatch risk.

## Examples

**Before** — the hidden copy opens a callout at the origin:

```tsx
useEffect(() => {
	if (!eligible || alreadyShownThisSession) {
		return;
	}
	claimSessionFlag(userId);
	setCalloutOpen(true);
}, [eligible, alreadyShownThisSession, userId]);
```

**After** — only the copy that is actually on screen opens one, and only it claims the flag:

```tsx
useEffect(() => {
	if (!eligible || alreadyShownThisSession) {
		return;
	}
	// Only the copy of the trigger that is actually on screen may open an
	// overlay — and it claims the session flag, so the hidden copy can't.
	if (!isAnchorOnScreen(anchorRef.current)) {
		return;
	}
	claimSessionFlag(userId);
	setCalloutOpen(true);
}, [eligible, alreadyShownThisSession, userId]);
```

The ref goes on the element the portal anchors to:

```tsx
<PopoverAnchor asChild>
	<span ref={anchorRef} className="block">
		{children(marker)}
	</span>
</PopoverAnchor>
```

## Related

- `docs/solutions/design-patterns/moving-a-floating-element-into-normal-flow.md` — the sibling trap in the other direction: a floating element moved into normal flow, with spacing and visibility pitfalls also caught by review rather than by the author.
- `docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md` — a different overlap failure in the same shell, caused by breakpoint reservation rather than portalling.

---
title: "Remapping theme tokens on an inverted surface: use the --color-* namespace, and keep the surface out of it"
date: 2026-07-20
category: design-patterns
module: web ui — shared tooltip primitive
problem_type: design_pattern
component: frontend_stimulus
severity: high
applies_when:
  - "A component paints an inverted or otherwise non-page surface (`bg-foreground`, a dark pill, a coloured banner) and hosts arbitrary caller-supplied children"
  - "Nested children carry ordinary theme utilities (`text-muted-foreground`, `text-primary`) that assume the page palette"
  - "Overriding Tailwind v4 design tokens at runtime, scoped to a subtree rather than globally"
  - "A shared primitive's defaults are being worked around by many call sites with slightly different values"
  - "Fixing a contrast defect by changing a semantic colour token"
tags: [tailwind-v4, css-custom-properties, design-tokens, contrast, wcag, tooltip, jsdom, verification, tailwind-merge]
related_components: [documentation]
---

# Remapping theme tokens on an inverted surface

- **Audience**: frontend engineers building components that invert or recolour a surface
- **Owner**: web app team

## Context

Fabric's shared `TooltipContent` defaults to an `inverse` surface: `bg-foreground text-background`, a dark pill in light mode and a light pill in dark mode. The pill itself is high-contrast. But ~52 of 582 call sites nest children carrying ordinary theme utilities — `text-muted-foreground`, `text-primary`, `text-highlight` — which resolve against the *page* palette, not the inverted one. Measured against the deployed build, 12 of 14 token/theme combinations failed WCAG AA. `text-foreground` came out at exactly **1.00:1**: literally invisible.

The reported bug ("tooltips are hard to read, both themes, everywhere") also blamed hardcoded colours and a third-party tooltip library. Both were wrong — zero call sites override colour, and Radix is imported in exactly two sanctioned files. The cause was the primitive's own defaults.

## The pattern

Re-point **Tailwind's `--color-*` namespace** on the element that establishes the surface. Children then resolve their normal utilities against the surface's palette without any call site changing:

```tsx
const INVERSE_TOKEN_OVERRIDES = {
  "--color-foreground": "var(--background)",
  "--color-muted-foreground":
    "color-mix(in srgb, var(--background) 72%, var(--foreground))",
  "--color-highlight":
    "color-mix(in srgb, var(--highlight) 35%, var(--background))",
  // …
} as React.CSSProperties;
```

Inside the element, `var(--foreground)` *is* the background and `var(--background)` *is* the text colour — the inversion is what lets one formula serve both themes. Accents keep 35% of their own hue so amber still reads as amber; the remaining 65% is the guaranteed-legible text colour, which carries the contrast. Result: all 14 combinations pass, worst case 7.08:1, with 52 call sites fixed untouched.

## Trap 1 — the raw token is not the one Tailwind reads

Overriding `--muted-foreground` deeper in the tree is a **silent no-op**. Tailwind v4 resolves

```css
--color-muted-foreground: var(--muted-foreground);
```

once at `:root`, so the indirection is already collapsed by the time a subtree override could apply. Verified in-browser:

| Override applied to a wrapper | Nested `text-muted-foreground` resolves to |
|---|---|
| `--muted-foreground: #d4cec8` | `#aaa39c` — no effect |
| `--color-muted-foreground: #d4cec8` | `#d4cec8` — applies |

Always target `--color-<token>`.

## Trap 2 — the surface must not read the namespace it remaps

This is the one that bites hardest, and it shipped past the first test run.

`bg-foreground` compiles to `background-color: var(--color-foreground)`. Putting the overrides on the same element that carries `bg-foreground text-background` makes the surface repaint itself with its own text colour:

```
before →  background rgb(17,17,16)     text rgb(250,250,249)
after  →  background rgb(250,250,249)  text rgb(250,250,249)   // 1.00:1
```

That is the *identical* defect the change was meant to fix, relocated from ~52 children onto the surface of ~554 default tooltips — and the arrow, being a descendant, inherited it too.

The fix is to paint the surface through arbitrary values that bypass the namespace:

```tsx
// not `bg-foreground text-background`
"bg-[var(--foreground)] text-[var(--background)]"
```

**General rule: a component that remaps `--color-*` must paint its own surface from the raw theme variables.**

## Trap 3 — jsdom cannot catch either trap

`getComputedStyle` in jsdom does not resolve `var()`. A unit test asserting inline-style *strings* passes while the component renders invisible — which is exactly how the 1.00:1 regression survived its first green run. Two mitigations, both used here:

- Assert **which namespace** the surface reads (`expect(className).toContain("bg-[var(--foreground)]")` plus a negative match on `bg-foreground`). Structural, but it pins the regression class.
- Put the real contrast assertion in a browser test. During development, a Playwright MCP session against the deployed build did this directly: build a probe element, apply the candidate overrides, and compute WCAG ratios from `getComputedStyle` via a 1×1 canvas — which resolves `color-mix()` and `var()` for free. Note that `color-mix()` output may come back as `color(srgb …)`, so a naive `/\d+/g` parse yields nonsense; route every colour through the canvas.

## Trap 4 — a semantic token is usually load-bearing in two directions

The same work surfaced `DestructiveTooltip` at 3.76:1 in dark mode. The obvious fix — darken `--destructive` — is a trap, because that token is both the background under `--destructive-foreground` *and* the ink of every `text-destructive` on the page:

| Approach | Tooltip surface | `text-destructive` on page |
|---|---|---|
| Darken `--destructive` to `#dc2626` | 4.83 | **3.91** |
| Flip `--destructive-foreground` to near-black | 5.02 | 5.02 |
| Darken on the component, `dark:` only | **5.76** | 5.02 |

The foreground flip measured clean and was still reverted: `button.tsx` hardcodes `text-white` for its `destructive` variants instead of reading the token, so the flip could not reach the primary destructive button — correctly, since that variant's dark background is `bg-destructive/60`, where near-black measures 2.48:1. Shipping it would have left delete-confirm dialogs near-black-on-red beside destructive buttons white-on-muted-red: *worse* consistency, from a change made for consistency.

**Before changing a semantic token, enumerate every surface it lands on — as background and as ink — and check whether any consumer bypasses it.** A token that some call sites route around is not a global lever.

## Corollary — bad defaults present as inconsistency

96 call sites each set their own `max-w-*`, spanning 19 distinct values, because the primitive shipped `w-fit` with no cap. That spread *was* the reported "visual inconsistency". Fixing the default (`max-w-[min(90vw,20rem)]` — the measure ~60 sites had already converged on) removes the reason to pick a value at all. `cn()` runs tailwind-merge, so deliberate overrides still win.

Deliberately **not** done: stripping the ~60 now-redundant `max-w-xs` declarations. They equal the new default; the only difference is a `90vw` term that binds below a 356px viewport. Sixty files of reviewer burden for approximately nothing. When a default is corrected, redundant call-site restatements stop mattering on their own — new code no longer has to choose.

## References

- Primitive: `apps/web/modules/ui/components/tooltip.tsx`
- Guard: `apps/web/modules/ui/components/__tests__/tooltip-surface.test.tsx`
- Standard: `fabric/standards/frontend/tooltips.md`
- Token definitions: `tooling/tailwind/theme.css`

---
title: Global Tooltip Styling - Plan
type: fix
date: 2026-07-20
topic: global-tooltip-styling
artifact_contract: ce-unified-plan/v1
artifact_readiness: stage-1-implemented
product_contract_source: ce-brainstorm
execution: code
---

# Global Tooltip Styling - Plan

- **Audience**: frontend engineers working on the shared tooltip primitive
- **Owner**: web app team

## Goal Capsule

- **Objective:** Make every tooltip in the app legible and consistently sized in both themes by fixing the defaults of the shared primitive, rather than continuing to patch individual call sites.
- **Product authority:** Confirmed in brainstorm dialogue on 2026-07-20. Two decisions are settled and should not be re-opened: the work ships as **two staged PRs** (primitive first, `title=` migration second), and native `title=` on iframes, on `<time>` timestamps, and the deliberate truncation affordance in `select.tsx` are **kept as documented exceptions**.
- **Execution profile:** Stage 1 is one primitive file plus a guardrail test plus mechanical call-site cleanup. Stage 2 is a wide, mechanical i18n migration across ~100 files.
- **Stop conditions:** Stop and surface if changing the primitive's defaults visibly regresses any tooltip that currently looks correct, or if the token-remapping approach turns out not to cascade to nested children as expected.
- **Tail ownership:** The user owns commit, push, and PR. Do not commit.

---

## Product Contract

### Summary

Tooltips are unreadable and inconsistently sized because the shared `TooltipContent` primitive ships two bad defaults: **no `max-width`**, and an **`inverse` colour surface that nested theme tokens cannot survive**. Across 582 call sites, 96 compensate for the missing width cap with 19 different hand-picked values, 53 do not compensate at all and render viewport-wide, and 52 place theme-token children on the inverted background where they drop to ~2.2–2.6:1 contrast. Fixing the primitive's defaults resolves all three classes at once. A separate, larger effort migrates 182 native `title=` attributes that bypass the design system entirely.

### Problem

The reported symptom is "tooltips are hard to read, in both themes, everywhere". The bug report's own root-cause hypotheses are both **refuted** by the codebase:

- *"Hardcoded colours not referencing theme tokens"* — no `TooltipContent` call site overrides background or text colour. Zero.
- *"A third-party tooltip library outside the theming system"* — `@radix-ui/react-tooltip` is imported in exactly two places, both the sanctioned primitives. Eight local `*Tooltip` wrappers all delegate to the shared component.

The actual causes, all located in `apps/web/modules/ui/components/tooltip.tsx`:

1. **No width bound.** The base class is `w-fit` with no `max-w-*`. Long copy (up to 180 characters in `tooltips.*` i18n entries) therefore stretches to whatever horizontal room exists. 53 call sites are unbounded today.
2. **Per-site compensation, not a shared default.** 96 call sites each set their own cap, spanning `max-w-xs`, `max-w-sm`, `max-w-md`, `max-w-56`, `max-w-60`, `max-w-[240px]`, `[250px]`, `[260px]`, `[280px]`, `[300px]`, `[320px]`, `[340px]`, `[360px]`, `[380px]`, `[420px]`, `[520px]`, `[15rem]`, `[16rem]`, `[min(90vw,640px)]`. This spread **is** the reported visual inconsistency.
3. **The `inverse` surface is hostile to nested theme tokens.** `inverse` renders `bg-foreground text-background`. The pill itself is high-contrast (~16:1 both themes). But any child carrying `text-muted-foreground`, `text-foreground`, `text-primary`, `text-highlight`, or `bg-muted` resolves against the *page* palette, not the inverted one:

   | Theme | Foreground | Background | Ratio | WCAG AA (4.5:1) |
   |---|---|---|---|---|
   | Light | `--muted-foreground` `#625c55` | `--foreground` `#1f1c19` | **2.57:1** | fail |
   | Dark | `--muted-foreground` `#aaa39c` | `--foreground` `#f4f1ec` | **2.21:1** | fail |

   26 call sites use those tokens explicitly; another 26 render structurally rich content on the same surface. Only 28 of 582 sites (4.8%) opt into `surface="popover"`, which is currently the only escape hatch.
4. **`text-balance` in the base** makes lines wrap short of the available width, which already forced a per-site `text-wrap` override in three places.
5. **182 native `title=` attributes across 100 files** render as OS tooltips: no theme, no delay, no i18n, no styling. The standards doc at `fabric/standards/frontend/tooltips.md` already forbids these; the rule has not been enforced.

This is a defaults problem that presents as a consistency problem. Every prior fix in this area has been per-site — `fix/title-tooltip-width` and `fix/title-tooltip-text-wrap` (both merged, both touching only the two editor title tooltips) and `fix/dup-meta-tooltip-surface`. Those are the "staging fix" referenced in the bug report; they are narrow and do not address the global cause.

### Users and value

Every user of the app. Tooltips are the primary discoverability affordance for icon-only controls and ambiguous actions, and the standard mandates one on every such control. Illegible tooltips degrade that affordance silently — the user sees a tooltip appear and still cannot read it. The contrast failures are an accessibility defect against the project's stated WCAG 2.1 AA floor, not only a polish issue.

### Requirements

**Stage 1 — the primitive (closes AC1, AC2, AC3, AC5)**

- `TooltipContent` carries a sensible default `max-width` so no tooltip renders wider than a readable measure without a call site asking for it.
- The default cap must stay inside the viewport on narrow screens.
- Call sites that already set `max-w-*` continue to win, via `tailwind-merge` conflict resolution. Changing the default must not silently re-size the 96 sites that set their own.
- Text inside the `inverse` surface meets WCAG AA (4.5:1) in both themes **including nested children that carry theme colour tokens**, without those call sites having to change.
- Line wrapping fills the available width rather than balancing to short ragged lines.
- Per-site `max-w-*` values that exist only to compensate for the missing default are removed where the shared default now covers them. Sites with a deliberate, distinct width stay as they are.
- A guardrail test fails when a new tooltip regresses these properties.

**Stage 2 — native `title=` migration (closes AC4)**

- Interactive controls that today rely on a native `title=` use the shared primitive instead.
- Migrated copy goes through `packages/i18n/translations/en.json` under the `tooltips` namespace, per the existing standard. No inline English strings.
- Documented exceptions are preserved and explicitly whitelisted by the guardrail: `<iframe title=>` (18 sites, required for a11y), the deliberate truncation affordance in `apps/web/modules/ui/components/select.tsx`, and `<time title=>` timestamp affordances.
- `fabric/standards/frontend/tooltips.md` records the exception list so the rule is enforceable rather than aspirational.

### Scope boundaries

**In scope**
- The shared primitive's default width, wrap behaviour, and colour-token safety.
- Removal of now-redundant per-site width compensation.
- A regression guard.
- Migration of native `title=` on interactive controls, with i18n.
- Standards doc update covering the exceptions.

**Deferred for later**
- The dead `@tippyjs/react` dependency (declared in `apps/web/package.json`, zero imports). Worth removing, unrelated to this bug.
- `tippy.js` usage for TipTap slash-command and mention popups. These are editor suggestion menus, not text tooltips.
- Recharts chart tooltips and the hand-rolled `ChartTooltipContent` in `AiUsageActivityView.tsx`. A separate surface with its own conventions.
- Radix `HoverCard` (3 sites). A different component with different semantics.

**Outside this change's identity**
- Rewriting tooltip *copy*. The standard's tone and content guidance is unchanged; this work moves and re-styles copy, it does not re-author it.
- Changing `delayDuration`, trigger behaviour, or placement logic.

### Success criteria

Mapped to the bug report's acceptance criteria:

- **AC1 / AC2** — every tooltip, including ones with nested theme-token children, clears 4.5:1 in dark and light. Verified by computing the ratio for the remapped tokens, not by eyeballing.
- **AC3** — no tooltip renders wider than the shared cap unless its call site deliberately overrides it; no tooltip truncates content.
- **AC4** — closed by Stage 2. Interactive controls all render through one primitive; remaining native `title=` are the documented exceptions only.
- **AC5** — no change to trigger, position, delay, or content. The existing suites at `apps/web/modules/ui/components/__tests__/destructive-tooltip.test.tsx`, `packages/i18n/__tests__/tooltips-namespace.test.ts`, and `apps/web/tests/contextual-tooltips.spec.ts` stay green.

### Dependencies and assumptions

- **Verified on staging 2026-07-20 — the token remap works, but only via the `--color-*` namespace.** Redefining theme custom properties on the `TooltipContent` element does cascade to nested children, *provided* the override targets the Tailwind-namespaced variable (`--color-muted-foreground`) and not the raw theme variable (`--muted-foreground`). Measured in the deployed build:

  | Override applied to a wrapper element | Nested `text-muted-foreground` child resolves to |
  |---|---|
  | `--muted-foreground: #d4cec8` | `#aaa39c` — **no effect** |
  | `--color-muted-foreground: #d4cec8` | `#d4cec8` — **applies** |

  Tailwind v4 resolves `--color-muted-foreground: var(--muted-foreground)` once at `:root`, so overriding the raw token deeper in the tree is a no-op. The same holds for `--color-foreground` and `--color-primary`. Building Stage 1 on the raw token would fail silently — the implementation must use `--color-*`.
- `cn()` uses `tailwind-merge`, so a call-site `max-w-*` overrides a base `max-w-*`. Already relied on in production by `fix/title-tooltip-text-wrap`.
- Theme tokens live in `tooling/tailwind/theme.css`; light and dark blocks both need a remapped value.

### Outstanding questions

- What exact default cap? Needs to be wide enough for the 180-character `testPmSync` copy without looking cramped, narrow enough that short hints stay pill-shaped. Non-blocking — settle during planning against real copy lengths.
- Should the `popover` surface get the same default cap, or does its richer content warrant a wider one? Non-blocking.

---

## Verification notes

Measured against the deployed staging build on 2026-07-20, not calculated on paper. Contrast of a child token against the `inverse` surface, before and after `INVERSE_TOKEN_OVERRIDES`:

| Token | Dark before | Dark after | Light before | Light after |
|---|---|---|---|---|
| `text-foreground` | **1.00** | 16.77 | **1.00** | 15.68 |
| `text-muted-foreground` | **2.21** | 7.15 | **2.57** | 8.66 |
| `text-primary` | **3.32** | 10.39 | 4.53 | 10.42 |
| `text-highlight` | **1.48** | 7.08 | 5.32 | 10.94 |
| `text-destructive` | **3.34** | 10.65 | **3.51** | 9.04 |
| `text-secondary` | **1.71** | 7.68 | **3.09** | 9.46 |
| `text-success` | **2.02** | 8.40 | **3.09** | 9.46 |

12 of 14 combinations failed AA before; all 14 pass after, worst case 7.08:1. The problem was wider than `muted-foreground` — nearly the whole accent palette was illegible on the inverse surface in dark mode.

Measured on the marketing route, where toggling `.dark` genuinely re-resolves the tokens. On `/app/*` the toggle does not (`--background` stays `#fafaf9` either way, and does not match the `#f7f6f2` in `tooling/tailwind/theme.css`), so single-route numbers there cover one theme only. Worth a look on its own: staging appears to be serving a build older than `master`.

### Regression caught in review — the first attempt was worse than the bug

The initial implementation applied `INVERSE_TOKEN_OVERRIDES` to the same element that carried `bg-foreground text-background`. Those utilities compile to `var(--color-foreground)` / `var(--color-background)`, and the override re-points `--color-foreground` on that element — so the surface repainted itself with its own text colour. Measured: background and text both `rgb(250,250,249)`, **1.00:1**, in both themes. The arrow inherited the same property and filled with the text colour too.

That is the identical defect the change set out to fix, relocated from ~52 child nodes onto the surface of ~554 default tooltips. It shipped past the first version of the test because jsdom does not resolve `var()` — the assertions checked inline-style *strings* and passed while the component rendered invisible.

Fixed by painting the inverse surface and arrow with arbitrary `bg-[var(--foreground)]` / `text-[var(--background)]` / `fill-[var(--foreground)]`, which read the raw theme variables and stay out of the remapped namespace. Re-measured after the fix: surface 18.09:1, arrow fill matches the background exactly, children 9.6–14.0:1.

The lesson generalises: **any component that remaps `--color-*` must not paint its own surface through that namespace.** The test now pins which namespace the surface reads, since asserting resolved colour is impossible in jsdom. A real-browser assertion belongs in `apps/web/tests/contextual-tooltips.spec.ts` and is not yet written.

The live DOM confirmed the deployed base classes carry `text-balance` and no `max-w-*`, matching the diagnosis. Call sites that already use inverse-aware tokens (`IncidentChip.tsx` uses `text-background/80`) were correct before and are unaffected.

**Separate defect found and fixed.** `DestructiveTooltip` does not route through `TooltipContent`; it paints `--destructive` / `--destructive-foreground` directly and measured **3.76:1 in dark mode** — below AA for its `text-xs` copy.

Two candidate fixes were tried and measured before one was kept:

| Approach | Tooltip surface (dark) | `text-destructive` on page (dark) | Verdict |
|---|---|---|---|
| Leave as is | 3.76 | 5.02 | fails AA |
| Darken `--destructive` to `#dc2626` | 4.83 | **3.91** | trades one AA failure for another |
| Flip `--destructive-foreground` to `#111110` | 5.02 | 5.02 | contrast-correct, but see below |
| **Darken on the component, `dark:` only** | **5.76** | 5.02 | kept |

`--destructive` is load-bearing in two directions — the background under `--destructive-foreground` *and* the ink of every `text-destructive` — which rules out darkening the token.

The foreground flip was implemented, then reverted. It is contrast-correct everywhere the token actually lands (all 23 call sites pair it with a full-opacity `bg-destructive`), but `button.tsx:18` hardcodes `text-white` for its `destructive`/`error` variants instead of reading the token, so the flip could not reach the primary destructive button. That is correct on its own terms: that variant's dark background is `bg-destructive/60` (≈`#96302F`), where near-black text measures 2.48:1 against white's 7.61:1. Shipping the flip would have left delete-confirm dialogs rendering near-black on red beside destructive buttons rendering white on muted red — worse consistency than before, from a change made in the name of consistency.

**Follow-up worth its own ticket:** unify the two destructive paths by moving the 23 hand-rolled `bg-destructive text-destructive-foreground` call sites onto `variant="destructive"`. Separately, `text-destructive` on the light-mode page background measures 4.47:1 — a hairline AA miss that predates this work.

### Deliberately not done

The plan called for removing per-site `max-w-*` that the new default now covers. **Skipped, on purpose.** ~60 sites use `max-w-xs`, which is 20rem — the same measure as the new default. Removing them would touch 60 files for no user-visible change; the only functional difference is that the base adds a `90vw` term, which binds solely below a 356px viewport. That is churn a reviewer must verify line by line in exchange for approximately nothing. The 19-value spread stops mattering the moment the default is right, because new call sites no longer have to pick one.

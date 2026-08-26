---
title: "Prevent browser credential autofill on search inputs (SearchInput primitive)"
date: 2026-07-08
category: best-practices
module: web UI search inputs
problem_type: best_practice
component: frontend_stimulus
severity: medium
applies_when:
  - "Adding a text search or filter input to a page, list, or dialog"
  - "A browser offers to autofill a saved email/account into a non-login field"
  - "Replacing many ad-hoc uses of a base component with one shared, safer primitive"
tags: [autofill, autocomplete, search-input, browser-heuristics, shared-primitive, accessibility, aria-role, forms]
related_components: [authentication]
---

# Prevent browser credential autofill on search inputs (SearchInput primitive)

## Context

A search box on the Roadmap page popped the browser's saved-email/credential
autofill dropdown on focus. The input rendered as a bare `<Input>` with no
`type` and no `autoComplete`, so browsers applied their credential heuristics
and treated the lone text field as a login/email input. This is a UX/first-
impression bug, not a data issue — but it looked broken, and the same latent
defect existed across ~60 other search boxes app-wide (`<Input>` and raw
`<input>`) that had no autofill guard.

## Guidance

Use a shared search-field primitive instead of hardening each call site by hand.

```tsx
// apps/web/modules/ui/components/search-input.tsx
const SearchInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ type = "search", autoComplete = "off", ...props }, ref) => (
    <Input ref={ref} type={type} autoComplete={autoComplete} {...props} />
  ),
);
```

- **Route every search/filter box through `SearchInput`.** It defaults
  `type="search"` + `autoComplete="off"` and forwards all `InputProps` + `ref`,
  so migrating a call site is a rename + import swap: `<Input …>` -> `<SearchInput …>`.
- **Do NOT change the shared `<Input>` default.** Login/email/password fields
  legitimately want autofill; a global default would break them. The guard
  belongs on a search-specific primitive, not the base component.
- **Raw `<input>` search boxes** with bespoke styling stay raw — just set
  `type="search"` + `autoComplete="off"` (and an `aria-label`) inline rather
  than forcing them into `SearchInput` and inheriting the base `Input` classes.
- **`cmdk` `<CommandInput>` already sets `autoComplete="off"`** (and
  `autoCorrect`/`spellCheck`) internally — leave those alone. Verify a library
  default before "fixing" it; don't add redundant churn.

## Why This Matters

- **`type="search"` is a stronger anti-autofill signal than `autocomplete`
  alone.** Some password managers ignore `autocomplete="off"` on `type="text"`
  fields; `type="search"` reads as "not a credential field" to more browser
  heuristics. Set both.
- **The autofill dropdown is domain-scoped, so it won't reproduce everywhere.**
  Saved credentials attach to a specific origin (`example.com` vs
  `staging.example.com`). The bug can be absent on staging purely because that
  subdomain has no saved creds. **Confirm the root cause by inspecting the
  input's DOM attributes (`type`, `autocomplete`, `name`, enclosing `<form>`),
  not by whether the visible dropdown appears.**
- **`type="search"` changes the ARIA role `textbox` -> `searchbox`.** Any test
  querying the field via `getByRole('textbox')` will break. Prefer
  `getByLabelText` / `getByRole('searchbox')` — role-agnostic label queries
  survive the change. (In this sweep, no existing test used the textbox role, so
  nothing broke — but that was verified, not assumed.)

## When to Apply

Any new or existing search/filter text input in the SaaS app. Not for login,
email, or password fields (they want autofill). Not for `cmdk` command palettes
(already guarded).

## Examples

**Before** — browser offers credential autofill:

```tsx
<Input placeholder="Search prompts..." value={q} onChange={onChange} />
```

**After** — plain search field, no credential autofill:

```tsx
<SearchInput placeholder="Search prompts..." value={q} onChange={onChange} />
```

**Sweep methodology** ("replace ad-hoc uses of X with shared primitive Y"):

1. Build the primitive + a unit test first (defaults, prop forwarding, ref,
   override), so migrations have a verified target.
2. Enumerate call sites and split by shape (shared `<Input>` vs raw `<input>` vs
   library input) — each shape migrates differently. Beware false positives:
   `re**search**` matched a "search" grep; `type === "x"` inside a placeholder
   template literal looked like a `type=` prop.
3. Parallelize the mechanical migration across disjoint file batches, then
   sanity-scan for dead/missing imports (an unused base-component import after
   migration is a lint failure).
4. Watch for call sites that pass an explicit prop that overrides the
   primitive's default (e.g. a leftover `type="text"` silently defeats the
   `type="search"` default) — grep every migrated site for the overridden props.

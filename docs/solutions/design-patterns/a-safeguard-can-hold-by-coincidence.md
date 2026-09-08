---
title: "A safeguard can hold by coincidence rather than by construction"
date: 2026-09-08
category: design-patterns
module: web shared providers, web config, web tests
problem_type: design_pattern
component: full_stack
severity: high
applies_when:
  - "A guard, provider, or test appears to enforce something, and you have not asked what would have to change for it to stop"
  - "Two independently-maintained values currently agree, and something reads correctness off that agreement"
  - "A nested provider from a second package is assumed inert because it collapses to a pass-through"
  - "A test asserts that a forwarded value matches the module the value came from"
  - "A test forces a state that happens to equal the production default"
tags: [coincidence, vacuous-tests, forwarding-tests, sentinel-mock, nested-provider, dependency-resolution, drift-test, defaults]
related_components: [next-themes, fumadocs, playwright, vitest, theming]
---

# A safeguard can hold by coincidence rather than by construction

## Context

Flipping one configuration value — the application-wide default UI theme, dark to light — surfaced three separate safeguards that looked like they enforced something and did not. None was broken. Each held only because two independently-maintained things happened to agree, and each would have failed silently the moment they stopped.

They are worth one entry rather than three because they are the same shape, and because the shape is invisible from inside any one of them. Reading the test, the provider, or the layout in isolation shows something that works. Only asking *what would have to change for this to stop working* separates a guarantee from a coincidence.

## Guidance

For anything you are treating as a safeguard, ask: **is this true by construction, or true because two things currently agree?** If the latter, name the second thing and either remove the dependence or pin it.

### 1. A nested provider is inert by dependency resolution, not by declaration

The marketing route tree mounted a documentation package whose `RootProvider` carries its own `next-themes` provider, defaulting to `"system"` under the storage key `"theme"` — different from the application's `"fabric-theme"`. It had no effect, because `next-themes` collapses a nested provider into a pass-through when it already sees an outer one through React context:

```js
// next-themes 0.4.6
J = e => useContext(x) ? <Fragment>{children}</Fragment> : <V {...e}/>
```

That context match exists only while both packages resolve to **one physical copy** of the library. `fumadocs-ui` declares `next-themes` as its own direct dependency, so a routine version bump onto a different major installs a second copy, `useContext` misses, and the entire marketing and documentation subtree silently reverts to following the operating system under a key nothing else reads.

The fix was one line and turned the coincidence into a declaration:

```tsx
<FumadocsRootProvider
  theme={{ enabled: false }}   // gated on `theme?.enabled !== false`
>
```

Note what this does and does not buy. It removes the shadow *writer*; it does not give that package's own `useTheme` readers a fallback — under the same duplicate-copy scenario they would read the library's no-op default context instead. Removing a competing provider is not the same as guaranteeing a shared one.

### 2. A forwarding test that reads both sides from one module is a tautology

A test meant to prove a component forwards configuration to a provider:

```tsx
// Green whether or not the component forwards anything.
expect(props.defaultTheme).toBe(config.ui.defaultTheme);
```

Replace the component's `defaultTheme={config.ui.defaultTheme}` with a hardcoded `"light"` and this still passes: both sides read the same module, and the module currently says `"light"`. The indirection through configuration exists precisely so a downstream deployer can choose a different value — the one guarantee the test was written to protect, and the one it could not detect losing.

Pinning the literal does not fix it either; a hardcoded `"light"` equals the literal too. The forwarding has to be observed against a value the production default **cannot** coincide with:

```tsx
// Deliberately not the shipped configuration.
const SENTINEL_UI = vi.hoisted(() => ({
  defaultTheme: "dark",
  enabledThemes: ["dark", "light"],
} as const));

vi.mock("@repo/config", () => ({ config: { ui: SENTINEL_UI } }));

expect(props.defaultTheme).toBe(SENTINEL_UI.defaultTheme);
```

The shipped value is then pinned separately, against the real module, in its own test. Two assertions that were one tautology become a value check and a wiring check, and the hardcode fails the second.

The same reasoning applies to `toEqual` on a forwarded object: the recorded prop is the *same reference* that was passed, so the comparison can detect an absent prop and nothing else.

### 3. A default that matches what a test forces makes the forcing untestable

An end-to-end test forced a dark theme by writing `localStorage["theme"]` — not the application's key — and adding a class that the reload immediately after discarded. Both mechanisms were dead. It passed because the application default was already dark, so the assertion found what it was looking for without the setup having produced it.

Nobody found this by reading the test. It surfaced because the default changed. That is the reusable detection heuristic:

> **When you change a default, the tests that break are the ones that were never testing what they claimed.** Treat every such break as a finding about the test, not an inconvenience.

## Why This Matters

A coincidence-backed safeguard is worse than no safeguard, because it is counted on. The nested provider would have activated during an unrelated dependency bump, with no test failing and the symptom appearing only for visitors on a documentation route with a dark operating system. The forwarding test would have kept a deployer-facing guarantee green while it was being removed. The end-to-end test would have gone on reporting that theme forcing worked.

All three are cheap to detect and cheap to fix. What they cost is the habit of asking the question.

## When to Apply

Ask "true by construction, or true by agreement?" whenever you are about to rely on:

- a nested or duplicated provider, context, or singleton from a second package
- a test whose expected value and actual value can be traced back to one source
- a test that forces a state, when that state might equal the production default
- any claim in a changeset or PR body that a safeguard "was checked" — say which paths were checked and which were not

## Examples

The falsification step is the whole discipline, and it takes one edit:

```bash
# Break it deliberately; confirm red; restore.
# Guard on the value:
-   defaultTheme: "light",
+   defaultTheme: "dark",
# => AssertionError: expected 'dark' to be 'light'   (test ran, 2 tests, 1 failed)

# Guard on the wiring:
-   defaultTheme={config.ui.defaultTheme}
+   defaultTheme="light"
# => AssertionError: expected 'light' to be 'dark'
```

Read the runner's summary line, not just its colour. A test that **skips** is green, and a skipped run of an inverted setup is indistinguishable from a working assertion — which is exactly the failure the falsification step exists to catch. The end-to-end test above self-skips without a seeded document path, so its repair is argued from source and says so, rather than claiming a verification that never happened.

## Related

- `docs/solutions/design-patterns/a-surface-must-not-report-absence-it-did-not-verify.md` — the neighbouring failure: an assertion that is vacuous because the setup never produced the case. This entry covers the case where the setup is fine and the *comparison* is degenerate.
- `docs/solutions/architecture-patterns/removing-a-fallback-promotes-every-path-that-relied-on-it.md` — changing a default promotes every path the old default kept rare. Enumerate the readers, not just the call sites.
- `docs/solutions/conventions/a-test-double-must-mirror-the-contract-not-the-convenience.md` — a double shaped for convenience tests the double. The sentinel mock above is that rule applied to a forwarding test.
- `packages/temporal/src/workflows/template-instance-execution.ts` strips `prefers-color-scheme: dark` from generated report HTML for the same operating-system-versus-application divergence, guarded by two tests. Prior art that was never written up.

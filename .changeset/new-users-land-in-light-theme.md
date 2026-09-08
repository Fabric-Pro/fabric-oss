---
"fabric-app": patch
---

A browser with no stored theme preference now renders Fabric in light mode, so a first visit lands on a bright interface instead of a dark one.

The default lived in one place, `config/index.ts`, as `defaultTheme: "dark"`,
consumed by the single next-themes provider the whole web app mounts. It is now
`"light"`. The value stays configuration rather than a literal because this
repository is deployed by others, who may want a different resting theme.

Worth knowing about the blast radius. Theme is stored per browser, only when
someone actually uses a theme control — next-themes never persists the value it
falls back to. So "new account" and "long-standing account whose owner never
touched the toggle" are the same case to the code: both present as empty
storage, and both now resolve to light. Anyone who did pick a theme keeps it.
One narrow exception is accepted rather than solved: the library's cross-tab
listener writes the current default when the key is removed in another tab, so a
browser that took that path before this change carries a literal `dark` and
stays there.

Three supporting changes:

1. A drift test pins the value *and* the wiring. Asserting the constant alone
   would stay green if the provider stopped forwarding it, so the provider test
   now drops its config mock and its pass-through stub of next-themes, and
   asserts the props the provider actually passes. The old mock hardcoded
   `defaultTheme: "light"` while asserting nothing about it, which read like a
   guard and was not one.

2. The marketing subtree's default is now explicit. Fumadocs' `RootProvider`
   mounts its own next-themes provider defaulting to "system" under the storage
   key `theme`. It was inert only because both packages resolved to one physical
   copy of next-themes, letting the nested provider collapse to a pass-through —
   an invariant a routine version bump could break, handing the whole marketing
   and docs subtree back to the OS preference under a key nothing else reads.
   Passing `theme={{ enabled: false }}` removes that provider outright.

3. An end-to-end test was forcing dark through `localStorage["theme"]`, but the
   app's key is `fabric-theme`, and the reload that followed discarded the class
   it set by hand. It passed only because the default already matched what it
   meant to force. It now seeds the real key before navigation. That repair is
   argued from source, not observed: the spec self-skips without a seeded
   document path and a live Excalidraw service, and no CI job runs Playwright,
   so it was never watched going red. The key itself is now pinned by a unit
   test that does run.

The assistant drawer's token bridge in `globals.css` was checked: every
CSS-custom-property path it uses is bound to one identical block of Fabric
tokens, so the operating system cannot pull the drawer's surfaces away from the
app's theme. Its `useDarkMode` hook is a separate matter — that one falls back
to a `prefers-color-scheme` media query in JavaScript, so on an OS-dark machine
it still reports dark while the app is light. Nothing token-bound depends on it.

The readers of the old default were enumerated rather than assumed: every
`useTheme` consumer in the app — logos, syntax highlighting, diagram palettes,
the Turnstile widget, toasts — selects an explicit light variant, and the light
palette is complete, with a `:root` counterpart for every custom property
defined under `.dark`.

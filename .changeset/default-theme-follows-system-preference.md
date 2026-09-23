---
"fabric-app": patch
---

A browser that has never had a theme chosen in it now follows the operating system's light or dark setting on first load, instead of always opening in light mode. Anyone who has picked Light, Dark or System keeps that choice; nothing stored changes.

The default lives in one place, `config.ui.defaultTheme`, and now reads `"system"`, which next-themes resolves against `prefers-color-scheme` in its pre-hydration script, so the resolved theme is applied before first paint rather than flashing. `"system"` is deliberately not added to `enabledThemes`: that list is the set of themes the app can actually render and is used to decide which classes to strip off the document element, while the library appends `"system"` to the selectable set on its own. The existing Light / Dark / System control is unchanged, and now correctly shows System as the active option for a browser that has not chosen.

The two guards around this value are retargeted rather than relaxed, and joined by a third. The drift test pins `"system"` and asserts both concrete themes stay selectable so either resolution can land; the forwarding test, which compares against sentinel values rather than the shipped ones, is unchanged and still proves the provider reads configuration instead of hardcoding a literal. Neither can distinguish a configured default from an honoured one, so a new test renders the real provider against a controlled `prefers-color-scheme` and asserts the class that reaches the document element, covering both operating-system settings and both stored preferences.

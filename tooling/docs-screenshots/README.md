# Docs screenshots

Renders the screenshots used by the public documentation under
`apps/web/content/docs`, writing PNGs into `apps/web/public/images/docs/qa/`.

```bash
node tooling/docs-screenshots/render.mjs             # all of them
node tooling/docs-screenshots/render.mjs pr-review   # one mock
```

## Why these are mocks and not captures of the running app

`apps/web/content/docs` is published to the public documentation site. A
screenshot taken from a running Fabric carries a real organization, project and
repository name in it, and once published that cannot be retracted. So each page
in `mocks/` reproduces the component with **synthetic data** — invented
repositories, features and test cases — on the **same design tokens** as the
product: every mock copies the light-mode `:root` block from
`tooling/tailwind/theme.css` verbatim and mirrors the component's own class
structure.

The result matches what a user sees without publishing anybody's data. It is not
a pixel-for-pixel capture, and it is not a substitute for looking at the real
surface: when a component changes shape, the mock has to be updated by hand.

**Never** publish an image from `.claude/ui-validation/` — those are captures of
staging and carry real organization and project names.

## Fonts

The app's `--font-sans` is Inter and `--font-mono` is JetBrains Mono, both via
`next/font`. The renderer fetches them once into `.fonts/` (gitignored) so the
type metrics match the product, and **fails** if Inter did not load — a silent
fallback would ship a screenshot that looks subtly unlike the app.

## Adding a screenshot

1. Add `mocks/<name>.html`. Copy the token block from an existing mock, then
   mirror the component's markup and class names — read the component, don't
   approximate it.
2. Wrap each shot in an element with an `id` (`<div id="shot-thing">`).
3. Register it in `SHOTS` in `render.mjs`. The filename is referenced from an
   `.mdx` page, so treat it as part of the published contract: don't rename one
   without updating the page.
4. Render, look at the PNG, and reference it from the page with a **descriptive
   alt text** — the docs site zooms images, and a screen-reader user gets only
   the alt.

The renderer fails if a mock has no `SHOTS` entry, and warns if a mock's tokens
have drifted from `theme.css`.

## Environment

Needs Playwright, resolved from `apps/web` (it is a dev dependency there). If
Playwright's own browser revision is not installed, point it at another
Chromium:

```bash
DOCS_SHOT_CHROME=/path/to/chrome node tooling/docs-screenshots/render.mjs
```

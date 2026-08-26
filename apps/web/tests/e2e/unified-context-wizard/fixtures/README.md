# Unified Context Wizard — Playwright fixtures

The multi-file upload spec (`multi-file-upload.spec.ts`) needs at least three
distinct PDF fixtures so the dialog's per-file status rows render with stable
identifiers.

Rather than duplicate the canonical `apps/web/tests/fixtures/sample.pdf`, the
spec reuses it three times under different filenames via Playwright's
`page.setInputFiles({ name, mimeType, buffer })` API. The shared bytes live at
`../../../fixtures/sample.pdf` and are documented in
`apps/web/tests/fixtures/README.md`.

This directory exists so future fixtures (e.g. a tiny `.docx` for mixed-type
uploads) can land here without polluting the global fixtures dir.

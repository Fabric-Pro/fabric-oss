---
"fabric-app": patch
---

Add a Design Document item to the project readiness checklist

Fizzy #2377. The checklist now carries a `design-document` row alongside
`architecture`, satisfied by a complete `DESIGN_SYSTEM` project document.

The generation side already shipped: `DESIGN_SYSTEM` is a full
`ProjectDocumentType` with its own prompt, RAG embedding, batch-generation
ordering and Documents UI. Only the readiness rule was missing, and because
`completeDocumentTypes` is built generically from every document type carrying
content, auto-completion needed no new detection code.

Need level is COULD in Discovery and SHOULD in Development — one step softer
than `architecture` at both phases, matching the card's "Should, not Must".
The row carries no `dependsOn`: architecture waits on a PRD or a connected
codebase because it is written from one, but a design system is derived from
code OR from uploaded design references, and the generation graph agrees
(`DESIGN_SYSTEM` is tier 1 with no prerequisites). Gating it behind a document
it does not need would hide a row the user could act on today.

Worth knowing before this reaches an environment: a SHOULD gap holds a project
at PARTIALLY_READY, so every Development-phase project that is READY today
drops to PARTIALLY_READY until it has a design system document or marks the
row Not Applicable. That is the same escape hatch `api-spec` and
`technical-spec` already rely on for projects those rows do not apply to, and
the card anticipates it explicitly for projects with no UI work.

The registry now holds 27 rules rather than the 26 the approved spreadsheet
defines; the sheet stays canonical for those 26.

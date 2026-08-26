# AI-chat attachment surfaces

What is shared, what is deliberately duplicated, and what must never be copied across the four surfaces that attach files to an AI chat.

- **Audience**: Engineers changing attachment behaviour on any AI chat surface
- **Owner**: Fabric platform

Four surfaces let a user attach a file to an AI chat. They behave alike now,
but they are not one implementation, and this records exactly where the seams
are — what is shared, what is still copied on purpose, and what must never be
copied at all.

Backed by `apps/web/__tests__/copilot/attachment-surface-drift.test.ts`, which
reads these files and fails when a surface builds its own envelope or restates a
bound the shared vocabulary owns. A prose map rots; the test is what keeps this
honest.

## The surfaces

| Surface | File | State model |
|---|---|---|
| Feature Assistant | `apps/web/modules/saas/shared/components/copilot/use-copilot-document-upload.ts` | The hook. Record array with a status union. |
| Loom Direct | `apps/web/modules/saas/agents/components/FabricChat/FabricDirectChat.tsx` | Its own record array, now typed from the hook's. |
| Loom Orchestrator | `apps/web/modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx` | Two queues: images (multimodal-vision) and its own document record array, typed from the hook's. |
| Nexus | `apps/web/modules/saas/ai/components/CopilotPage.tsx` | Its own record array with the same status union. |

Loom Orchestrator was, for a time, the one surface left out: it had an
image-only paperclip and no document path, so "attach an Excel to Loom" failed
in the mode users land on by default. It now carries the shared document
pipeline too — but with a twist the other three don't have. It keeps a separate
image queue for the multimodal-vision path (`upload-image` → storage path) and
routes documents to the RAG/inline queue, splitting each picked or pasted file
by whether it is a client-renderable image. One paperclip fills both.

Loom Direct and Loom Orchestrator are intentionally separate implementations
rather than migrations onto the hook: they carry chat-id propagation the hook
does not model, and Nexus has no attachment state to migrate. Parity was
reachable without consolidation; consolidation can follow now that the four
behave alike.

## Never duplicated

**The envelope and its neutralizers.** `buildAiChatAttachmentEntry` in
`packages/utils/lib/ai-chat-attachment.ts` is the only place the delimiter is
written and the only place a filename or a document body is neutralized. Five
callers: the four surfaces above and the server-side story-media resolver at
`packages/api/modules/projects/procedures/stories/resolve-story-media-for-agent.ts`.

Duplication is acceptable for state and rendering. It is not acceptable here: a
fix applied to one copy and not the others is a silent hole, and the copy that
gets missed is the one nobody remembers exists. That resolver is the proof — it
built the same envelope server-side with no neutralizer at all while the client
path was guarded.

The drift guard asserts each surface calls the builder and that none of them
contains the literal delimiter.

**The size cap and the format allowlist.** Both come from
`@repo/utils/ai-chat-attachment`. The cap was declared five separate times as
`10 * 1024 * 1024`, which is how the paperclip and the paste path ended up
refusing at different sizes on the same surface. The guard asserts that literal
no longer appears.

## Deliberately not flattened

These look like drift and are not. Collapsing them breaks something.

**The Feature Assistant narrows images to JPEG and PNG.** It compresses through a
canvas, and browsers do not decode TIFF. Nexus and Loom Direct accept TIFF
because they run no canvas step and the server OCRs it. `AI_CHAT_IMAGE_MIME_TYPES`
is what a client can originate; `AI_CHAT_SERVER_ONLY_MIME_TYPES` is the rest of
what the server admits. Union them and either the server starts rejecting TIFF it
accepts today, or a canvas is handed an image it cannot read.

**Two extension guards.** `AI_CHAT_ALLOWED_EXTENSIONS` is the narrow client set;
`AI_CHAT_SERVER_ALLOWED_EXTENSIONS` includes the server-only types. Surfaces that
do no canvas step need the wider one, because paste and drop routinely deliver
files with an empty `type` and the narrow list would refuse a `.tiff` the same
surface accepts by MIME.

**Three text partitions, not one list.** `AI_CHAT_TEXT_MIME_TYPES`,
`AI_CHAT_BINARY_DOCUMENT_MIME_TYPES`, and the image sets drive
`isBinaryDocument()`, which decides whether a file is read in the browser or
uploaded for server extraction. Collapse them and text attachments stop being
read client-side. This is also why `text/csv` sits with the text formats: that
placement is what gives it a character budget.

## Still duplicated, on purpose

Copy-paste that remains, so it is visible rather than folkloric.

- **The attachment record's shape.** Loom Direct and Loom Orchestrator both
  take the hook's `AttachedFile` type rather than restating it, each adding one
  local field (`contextEntry`). Nexus declares its own `NexusAttachment` with
  the same status union — it queues before an upload exists rather than around
  one, so it carries no `documentId`. Four records, one union.
- **When the chips clear.** The Feature Assistant and Loom Direct upload before
  send and clear on it. Nexus uploads *during* send, so clearing there would
  drop the chips before the first byte moved; it clears once every file has
  settled with nothing worth saying instead. Same guarantee, different moment,
  because the pipelines genuinely differ.
- **The upload sequence.** All four run create-URL → PUT-or-server-upload →
  process. The base64 fallback block is written out four times.
- **The sr-only file-input pattern**, with its Chromium-124 comment, appears on
  each surface.

Format-list validation is **no longer** in this list. Loom Direct's picker and
paste paths, and Nexus's queue, all gate on `DEFAULT_AI_CHAT_MIME_ALLOWLIST`
plus `AI_CHAT_SERVER_ALLOWED_EXTENSIONS` rather than hand-rolled arrays. That
consolidation was forced by a bug: Loom's `accept` attribute was derived from
the vocabulary and offered `.xlsx`/`.csv`, but its validation gate was a local
`allowedTypes` array that omitted them, so the picker offered files the gate
then refused. The drift guard now asserts no surface hand-rolls an
`allowedTypes` array and that both client-validating surfaces read the shared
allowlist — see `apps/web/__tests__/copilot/attachment-surface-drift.test.ts`.

## What each surface sends the model

All four now deliver a file's text **inline**, in addition to the retrieval
path — not instead of it. Inline gives completeness on a small file; retrieval
covers the part a character budget had to cut, and is what still works when a
file is far past the budget.

| Surface | Inline route |
|---|---|
| Feature Assistant | `onContentExtracted` → the host's rag-context state |
| Loom Direct | `inlineAttachmentContexts` → `/api/agents/fabric-ai/stream` → `DirectChatWorkflowInput` |
| Loom Orchestrator | `inlineAttachmentContexts` (via `useOrchestratorStream`) → `/api/agents/fabric-ai/orchestrator-temporal/stream` |
| Nexus | `inlineAttachmentContexts` → `/api/agents/fabric-ai/orchestrator-temporal/stream` |

The Orchestrator's route already destructured `inlineAttachmentContexts` and
`attachedDocumentIds`; the gap was that `useOrchestratorStream` never put the
inline field on the wire. The composer now collects it and the hook sends it,
merging composer-uploaded document ids with any pre-attached prop ids.

The direct-chat workflow joins the inline entries with whatever retrieval
returns. It used to *assign* the retrieval result over the top, which discarded
anything seeded — see `joinRagContextParts` in
`packages/temporal/src/workflows/direct-chat.ts`.

## Bounds

The character budget applies to the chat path and nowhere else. Two places
enforce it:

- the browser, for text formats it reads itself
  (`applyAiChatTextBudget` in the upload hook);
- `packages/api/modules/ai/procedures/documents/process-document.ts`, for
  everything extracted server-side — the workbook walk honours the budget option
  itself, and the backstop there covers PDF, DOCX, and plain text, which do not.

Knowledge-base ingestion stays unbounded, deliberately. The four Temporal
ingestion activities pass no options, and a budget applied inside the shared
extractors would cut documents mid-ingest and embed the truncation marker into
the vector store as though it were content.

## File pickers outside the AI chat

Three surfaces attach files without going near an AI chat, so none of the
envelope or chat-budget rules above apply to them. What does apply is the rule
that produced those rules: a picker's `accept` attribute and the gate behind it
read one vocabulary rather than restating it.

| Surface | Component | Vocabulary |
| --- | --- | --- |
| Project context | `apps/web/modules/saas/projects/components/ContextUploaderDialog.tsx` | `packages/utils/lib/context-upload.ts` |
| Project wizard | `apps/web/modules/saas/projects/components/wizard/WizardFileUploader.tsx` | `packages/utils/lib/context-upload.ts` |
| Workspace documents | `apps/web/modules/saas/workspaces/components/DocumentUploader.tsx` | `packages/utils/lib/workspace-document-upload.ts` |

Both vocabularies compose from one shared core, `packages/utils/lib/document-format-core.ts`,
which names the document formats extractable as AI context and projects them into
an allowlist, an `accept` attribute, format labels, and a forced-extension map.
The core is not a merged vocabulary — the surfaces stay deliberately different.
Project context adds screenshots for OCR and Excalidraw scenes; workspace
documents is a document library and takes the core alone. Adding a format to the
core reaches both surfaces and every artifact derived from them at once, which is
what stopped the two lists drifting: workspace documents sat at five formats
while project context carried thirteen, and JSON was attachable in a chat but not
uploadable as project context, though one extractor served both. Fizzy #2149.

A format only joins the core once a registered extractor claims its MIME type;
`packages/rag/lib/extraction/__tests__/vocabulary-extractor-coverage.test.ts`
asserts that, so an admitted-but-unextractable type fails a test rather than
producing a stored row that dies at extraction.

Each vocabulary derives its `accept` attribute from its own allowlist, and each
emits **dotted extensions** rather than bare MIME types. That is not cosmetic:
the browser fills `File.type` from the operating system's MIME registration, so
a MIME-valued `accept` greys a file out of the file dialog entirely on any
machine where the extension is unregistered — which is the default for `.md` on
Windows. The workspace picker carried exactly that bug until Fizzy #2139.

For the same reason every gate resolves an unrecognised MIME against the
filename extension instead of refusing it. A file the OS did not type arrives
with an empty `File.type`, the client substitutes `application/octet-stream`,
and a gate that only knows MIME types refuses a format its own picker
advertises. Most of the extensions the context picker offers were refused that
way — a specific count belongs in the ticket, not here, since the picker's set
grows.

Formats whose declared type is routinely wrong or absent are resolved from the
extension *ahead* of the declared value, through each vocabulary's forced map.
That single step does three jobs: it rescues an untyped file, it canonicalizes an
alias spelling (`text/xml` onto `application/xml`, `.yml` onto
`application/yaml`), and it stops a wrong declaration routing a file to the wrong
reader. One canonical MIME per format is what keeps extraction working, since the
extraction factory matches the exact string — admitting both spellings of XML
would send half those uploads to no extractor at all.

The forced map is also why `.svg` is forced. `image/svg+xml` is read as text
rather than sent to OCR, and once `application/xml` joined the core, an `.svg`
whose declared type is `application/xml` would otherwise have resolved to XML —
a recognised declared type beats the extension. Forcing `.svg` is what keeps it
resolving to itself.

The new formats are canonicalized through those per-surface forced maps rather
than through `EXTENSION_MIME` in `packages/utils/lib/attachment.ts`. That map is
shared, and `ATTACHMENT_ACCEPT_ATTR` is built from its keys and feeds the
story-attachment picker — so adding `xml`, `json` or `yaml` there would advertise
those formats on a fourth surface whose gate refuses them, which is the exact bug
this page's rule exists to prevent.

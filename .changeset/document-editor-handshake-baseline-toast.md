---
"fabric-app": patch
---

Stop the document editor reporting a failed AI review when the assistant handshake starts before the editor has mounted

Opening a document showed "Couldn't read the document content to start this AI review — please retry." although no AI review had been started.

`useCopilotChat().isLoading` is `Boolean(agent?.isRunning)`, and the AG-UI connect handshake sets `isRunning` on every mount with no user request behind it — the reason `useUserRunSignal` exists for the "Generating" pill. The document editor's baseline effect treats any `false → true` transition of that flag as the start of a review and serializes the editor to capture a baseline. But `DocumentEditorInner` mounts late — behind the document query, the org-context gate, and, where collaboration is enabled, the Yjs connect-and-sync gate — while `useEditor` runs with `immediatelyRender: false`, so `editor` is `null` on its first commit. `getEditorMarkdownForSave(null)` returns `null`, which the effect could not tell apart from a Turndown failure, so it raised the toast.

The effect now returns early when the editor instance does not exist yet, before the branch that toasts and before the `wasLoadingRef` write that consumes the transition — so the baseline is still captured when the editor arrives (`editor` is already a dependency). A genuine serialization failure, with an editor present, still toasts.

`StoryWorkspace` carried the mirror image of the same gap: it guarded the capture on `editor` but consumed the transition anyway, so a run starting before its editor existed silently lost its baseline — and Effect 3 treats an empty baseline as "no prior content" and replaces the editor with the AI's raw output. It now takes the same early return.

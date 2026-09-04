---
"fabric-app": patch
---

Show the document read-only with a reload option when the document assistant fails to start, instead of losing the editor

`DocumentEditorPage` wrapped `<CopilotKit>` and `<DocumentEditor>` in an error boundary whose fallback rendered `<DocumentEditor>` again with no provider above it. `<DocumentEditor>` calls `useCopilotChat`, `useCopilotChatInternal` and `useCoAgent` unconditionally and renders `<CopilotSidebar>`; on CopilotKit 1.70 each of those throws when no `<CopilotKit>` is mounted, so the fallback threw as soon as it rendered and the route's error page took over. The fallback was dead code.

The boundary now renders `DocumentEditorAiUnavailable`, a panel that imports nothing from CopilotKit: it explains that the assistant could not start, shows the caught error message, offers a page reload, and renders the document's saved markdown read-only from the payload the page already fetched. The boundary's `fallback` prop takes a function so it can hand the caught error to the panel. Two tests pin the behaviour: one renders the panel with a mock that throws if `@copilotkit/react-core` is imported, and a page-level regression test makes `<CopilotKit>` throw on render and the stubbed `<DocumentEditor>` throw the way the real one does outside a provider, then asserts the panel appears with the document content and the editor was never re-mounted. Fizzy #2393.

---
"fabric-app": patch
---

Prompt pages keep what they already loaded when a refresh fails, and the prompt picker says when it could not load instead of claiming no prompts exist.

Fizzy #2249, post-ship review follow-up to the first load-failure change.

- Regression fix: the load-failure branches checked `error` alone. React Query keeps the last good `data` when a background refetch fails (window refocus after the 60s staleTime), so a network blip replaced a loaded page with the failure state. On the prompt detail page this unmounted an open editor and discarded unsaved text. The failure state now shows only when nothing is loaded (detail, enhance, preview, catalog, governance, library, settings list).
- PromptSelector (document and feature creation flows): a failed `prompts.agents.available` read rendered "No custom prompts available". It now shows "Could not load prompts." with Try again, and the trigger no longer falls back to the "use default" placeholder when a selected prompt could not be resolved.
- PromptBindingManager (detail page Set as Default): a failed prompt read silently disabled the button. It now explains why and offers Try again.
- Shared-edit warning: a content save made before the bound-actions read returns also had unknown reach and skipped the warning. The honest confirmation now covers loading as well as failure.
- FORBIDDEN on `prompts.get.byId` now gets the "does not exist, or you do not have access" copy instead of a Try again that can never succeed. Helper renamed `isPromptInaccessible`.

Not changed: client-side logging in the shared oRPC interceptor.

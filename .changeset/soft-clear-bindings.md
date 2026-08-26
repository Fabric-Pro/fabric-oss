---
"fabric-app": patch
---

Clearing a prompt default keeps the binding available for one-click restore.

Fizzy #2068, FR12. Clearing an override used to delete the binding row: the prompt and its versions survived in the library, but the action's catalog list lost the variant, so putting things back meant leaving the catalog entirely. Every reader in the prompt system already understands a softer state — `bindPromptVersion` writes rows with `isDefault: false` for binds saved without "set as default", the resolver filters `isDefault: true` at every tier, the catalog lists such bindings as offers rather than the thing in force, and `groupPromptCatalogBindings` even documents that "a tier whose binding is not default is listed but does not win, which is exactly what a cleared override looks like". Clearing was the one writer still destroying rows behind a system built to carry them.

**What changed:** `clearPromptBinding` flips `isDefault` to false instead of deleting; clearing an already-cleared tier now reports `{ cleared: false }` instead of claiming success twice. The two caller-override deletions inside `bindPromptVersion` (setting a SYSTEM or ORG default used to DELETE the caller's USER row) get the same treatment, so a person's preference survives being superseded and can be restored from the catalog. The composite unique key caps it at one row per target+scope+owner, so cleared rows cannot pile up.

**Verified red→green on a real database:** with the old delete code in place the new suite fails its five soft-state cases (row gone, catalog empty, badge silent, restore creates a second row); with the fix all 7 pass, plus the existing tier-resolution suite stays green after one assertion there moved from counting rows (deletion as mechanism) to asserting which tier was affected (its actual intent). Disposable postgres:16-alpine on :55432, migrations deployed fresh each run.

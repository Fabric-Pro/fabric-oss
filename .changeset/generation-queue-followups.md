---
"fabric-app": patch
---

Stop handing a generation run the same source twice, and localize the regenerate toast

Two follow-ups from the dependency-aware generation queue (Fizzy #2199).

**A misspelled key sent nothing.** `project-context-processing.ts` passed
`suppliedContextId` to a child workflow whose input has only ever declared
`excludeContextId`. `executeChild` starts the workflow by string name with
untyped args, so the wrong key raised no type error and simply never arrived:
the context row that run had just ingested was never excluded from the run's own
retrieval, and the model was handed the same source twice — once directly as
`suppliedContext`, once again out of the corpus.

The unit test covering that call site asserted `suppliedContextId` too. It was
written from the same reading as the code it was checking, in the same change,
so it certified the misspelling rather than catching it — the same shape as the
terminal-status guard whose test asserted the defect as intended behaviour.

Prevention is aimed at the class, not the instance. `supplied-context-wiring`
now derives the field names `ProjectDocumentGenerationInput` actually declares
and asserts that every key an outside caller passes is one of them, so any
future misspelling at any call site fails rather than disappearing. Verified by
reintroducing the old key: two assertions go red, including the generic one.

**The regenerate toast was English-only.** Its three messages were string
literals in the component, in a file that already had `useTranslations` wired.
The helper now returns a translation key instead of copy — which also takes
English out of its unit assertions — and both shipped locales carry the wording,
including the interpolated failure message.

No schema change, no workflow command added, so no new patch marker and no
replay implication.

---
"fabric-app": patch
---

Platform administrators can now delete system prompts from the Prompt Management UI, with a platform-wide impact warning, and a deleted prompt no longer returns on the next catalogue seed.

Fizzy #2328. The backend already authorised the deletion; three listing surfaces each decided for themselves that anything SYSTEM-scope was untouchable, so the control was never rendered — no disabled button, no error, nothing to report. Confirmed on staging, where every prompt in the library carries SYSTEM scope and the card menu offered only Preview, Duplicate, Set as Default and View in Catalog.

Two things made the obvious fix insufficient.

Deleting a prompt cascades through its versions into its bindings, and those bindings belong to organizations and individuals other than the one the administrator is looking at. A warning built from the ordinary tenant-scoped read would have reported zero while removing several, so the impact read is deliberately un-scoped and gated by exactly the authority the deletion itself requires. It reports totals only and never names an organization or a person. The figures shown before confirmation are a snapshot; the deletion reports what it actually removed, derived from its own DELETE ... RETURNING rather than a count taken beforehand.

And two independent seed scripts plus the product's own create endpoint would each have recreated a deleted prompt from its key, under the catalogue name rather than the retirement-prefixed name in the database — turning a prompt that was clearly marked dead into one that looks current. A deletion now records the key, every creation path consults that record inside the same transaction that inserts, and both sides serialise on a per-key advisory lock. Neither seed catalogue was edited, so the retention decision pinned by the seed-source test still holds.

Deleting a system prompt retires the key rather than one row: duplicate SYSTEM keys are legal, prompt resolution takes the first match, and removing only the selected row would have left a survivor answering the same key while the UI reported success. A fork made by an organization survives its parent's deletion — a platform action does not remove a tenant's data.

Unblocks the prompt cleanup tracked in Fizzy #2292, which needed exactly this and had been working around it with a hand-run seed script.

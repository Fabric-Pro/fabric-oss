---
"fabric-app": patch
---

Give a live project an edit screen that asks the same four questions as project creation.

Fizzy #2247. "Edit Project" on an active project now opens a single-step screen with the project's title, brief, phase and — while it is in Discovery — its expected development start date, prefilled and saved in one action. Previously the button pushed an active project at the five-step creation wizard as `?step=1`, which is the requirements/code mismatch the card names.

The creation form and the edit screen are one component with a `mode`, not two. They ask the same four questions and differ only in what they do with the answers: `create` activates a project, fresh or resumed from a draft, and lands on Overview where the readiness checklist takes over; `edit` changes a project that is already live and never writes its status, so an edit can never re-activate something that was archived. Keeping them as one component is what stops the two screens drifting into asking for different things.

Two behaviours are deliberately suppressed while editing. A live project never autosaves a draft — doing so would write a DRAFT row beside it and surface the project in the "unfinished draft" banner. And the duplicate-name check is skipped, because the endpoint has no notion of "except this one" and an unchanged name would report itself as taken and block the save.

The screen is gated on SIMPLIFIED_PROJECT_CREATION and on the caller's own update permission, resolved server-side before anything renders and taken from the same source the mutation itself consults. A member who can read a project but not change it is sent back to the project rather than shown an edit form; a draft is sent to the creation flow, which is what knows how to resume and activate it. With the flag off the screen does not exist at all and the button reaches the wizard exactly as before, so the rollback lever still restores the previous behaviour whole.

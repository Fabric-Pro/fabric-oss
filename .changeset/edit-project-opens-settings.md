---
"fabric-app": patch
---

Point "Edit Project" at project settings when the simplified creation flow is on, instead of a creation route that sends it straight back.

Fizzy #2247 follow-up. The button has always pushed an ACTIVE project at the creation route as `?step=1&projectId=`, which is the requirements/code mismatch the card names. With SIMPLIFIED_PROJECT_CREATION on, that route now redirects an ACTIVE project back to the project — so the button navigated to the page it was already on and read as doing nothing. Found on staging immediately after the flag was switched on.

An active project's name, brief, phase and expected development start date are all editable in Settings, so that is where the button now goes, via the existing in-page settings deep link rather than a route change.

Scoped to the flag on purpose: with SIMPLIFIED_PROJECT_CREATION off the button still reaches the wizard at the Brief step exactly as before, so the rollback lever does not change a second thing as a side effect. A DRAFT resumes in the creation flow under either value — it has never been created, so there is nothing in Settings to edit.

Five tests cover both flag values against both project statuses.

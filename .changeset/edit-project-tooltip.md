---
"fabric-app": patch
---

Correct the "Edit Project" tooltip, which described the wizard rather than the edit screen.

Fizzy #2247. The tooltip promised "project name, description, repository link, and integrations" — accurate for the five-step wizard, wrong for the edit screen, which asks only for the title, brief, phase and expected development start date. Repository links and integrations moved to the project's own tabs and settings.

The copy now follows the same switch the button's destination does: with SIMPLIFIED_PROJECT_CREATION on, an active project gets the new wording; with it off, or for a DRAFT resuming in the creation flow, the wizard's own copy is what is accurate and is what shows. Only `en.json` carries this namespace, so there is no second locale to update.

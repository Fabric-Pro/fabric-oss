---
"fabric-app": patch
---

Add a single-step project creation form, behind a switch that restores the five-step wizard.

Fizzy #2247 (Project Suite 5A). Creation now asks for a title, a brief, the project phase, and — while the project is still in Discovery — an expected development start date, then activates the project and lands on Overview, where the readiness checklist takes over as the guidance surface. It starts nothing: no codebase analysis, no document generation.

Shipped behind `SIMPLIFIED_PROJECT_CREATION`, registered in the UI-editable flag registry (`orgScopable`, default false, resolved server-side in the route). The five-step wizard is deliberately left intact behind the switch, so rollback is a console change rather than a redeploy and one organization can be piloted ahead of the deployment. Removing the wizard and its ~9,200 lines of attached tests is a follow-up, once the switch has soaked — the same shape as UNIFIED_AGENT_INTERFACE.

Deliberately NOT ANDed with PROJECT_READINESS: nothing in the simplified path reads readiness, so the dependency is one of rollout order rather than of code, and a code AND would make the switch read "on" while the behaviour was off because readiness had been toggled for an unrelated reason. The dependency is stated in the registry note instead.

Draft behaviour is preserved in both directions. `projects.saveDraft` now persists `projectPhase` and `expectedDevelopmentStartDate` as typed columns — neither was persisted before, so a resumed draft lost the two fields the new form makes required (FR34). Both ride the existing `if (x !== undefined)` guards in `upsertDraftProjectByKey`, so the wizard's own autosave, which sends neither, cannot wipe a value the form saved.

Three data-loss paths were closed on the way:
- Resuming a DRAFT activates through `projects.update`, never `projects.create({ draftKey })`. Create's activation branch writes `techStack: input.techStack || []` (and the same for features, projectTypes, tags), so a four-field payload would have blanked whatever a draft abandoned at the old step 2/3 had saved.
- A resumed draft autosaves under the `draftKey` already on the row, and a draft that has none (written by the v1 API or the agent tool) does not autosave at all — minting a key in either case would have upserted a second draft beside the one being resumed.
- Radix re-emits an empty value while syncing a controlled Select whose value changed from outside the trigger, which silently wiped the phase restored from a draft one render later and left the form unsubmittable. Guarded, and pinned by a test.

An ACTIVE project reaching the creation route is now sent to the project itself rather than to a creation form — the requirements/code mismatch the card names — gated on the flag so that turning it off restores the previous route behaviour exactly.

21 new tests across the form and the route; the wizard's own 98 are untouched and still green.

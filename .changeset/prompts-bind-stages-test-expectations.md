---
"fabric-app": patch
---

Fix the `prompts.bind.listForStages` test expectations left behind by the project prompt tier, which were failing on master.

`listForStages` now forwards `projectId` and `scope` to `listPromptsForStages` — always, null and undefined included, so the resolver sees one argument shape rather than two. The three `toHaveBeenCalledWith` assertions still described the pre-project shape, so master was red and every PR opened against it inherited the failure.

Test-only: the procedure is the source of truth here and the extra arguments are the feature.

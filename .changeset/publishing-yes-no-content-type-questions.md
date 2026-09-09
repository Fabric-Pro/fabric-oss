---
"fabric-app": patch
---

Content-type questions on a publishing topic now answer with Yes or No instead of a free-text box

Fizzy #1851. "Should we produce a Blog Post for this topic?" arrived with a textarea and a Submit button, so answering a yes/no meant typing prose. Every content type asked the same way.

These stay questions rather than becoming a project setting, and the data is the reason: the wording is templated per type, but the rationale printed beneath it is written about this specific topic. FR39 binds recommendations that need confirmation and each of these is one — so what changes is the affordance, not the decision model. The answer still lands in the Decision Log and still survives the next regeneration.

"Answer in your own words" stays beside the two buttons, because "yes, but only once the metric is approved" is a real answer a boolean would throw away.

A Yes or No records as a manual answer rather than as accepting the AI's suggestion — the acceptance metric would otherwise count a button that never showed the suggestion.

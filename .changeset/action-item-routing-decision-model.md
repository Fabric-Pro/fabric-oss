---
"fabric-app": patch
---

Action-item create-vs-enrich routing now uses an organization's configured decision model to settle confident verdicts before falling back to the language judge.

The typed evaluation decides in one call both whether a captured action item is new work or additional detail on an existing ticket, and which ticket it belongs to, over the same operator-tunable judge prompt the language judge receives. A create verdict is taken when the routing answer is confident; an enrich verdict is taken only when both the routing answer and the target ticket answer are confident and the target is on the candidate shortlist. No configured decision model, an uncertain or malformed answer, or an evaluation error other than an exhausted usage limit all fall through to the existing language judge, so routing behaves exactly as before for organizations without a decision model. An exhausted usage limit marks that item as not evaluated, as it does today.

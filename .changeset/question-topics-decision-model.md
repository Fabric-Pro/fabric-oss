---
"fabric-app": patch
---

Maturation question topic labelling now uses an organization's configured decision model for confident topic verdicts before falling back to the language model.

Unconfigured, uncertain, or failed evaluations fall back to the existing language pass for the remaining questions; a usage limit yields the same all-"Other" result as before without a second model call.

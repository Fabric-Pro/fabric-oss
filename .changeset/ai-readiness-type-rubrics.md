---
"fabric-app": patch
---

Make AI Readiness use type-specific rubrics while excluding engineering-only investigation work from product readiness gaps.

AI Readiness now applies separate Bug and Feature criteria, treats explicit
deferrals, accepted alternatives, existing capabilities, and out-of-scope work
as non-gaps, and detects genuine product contradictions. Engineering sections
and questions remain available as labeled reference context without affecting
the score. Section partitioning supports Markdown and bold labels, canonical
Bug and Feature headings, parenthetical heading suffixes, and malformed nested
product sections observed in imported or hand-authored specifications. Changing
a work item's kind now clears any displayed assessment so the next evaluation
uses the current rubric.

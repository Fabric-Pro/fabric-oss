---
"fabric-app": patch
---

A publishing topic now shows how many of its decisions are answered, and puts the questions above the reference material

Fizzy #1851. Two asks from the same review. The Summary & Questions tab led with metadata and buried the open questions below it, though the questions are the actual work on that tab. And there was no equivalent of Feature Maturation's readiness indicator, so nothing said how close a topic was to being safe to draft from.

Readiness is mirrored in intent rather than in component. A feature moves through a fixed stage pipeline, so its bar is positional. A publishing topic has no pipeline — what it has is a set of decisions the analysis raised, each answered or not — so the honest signal is the proportion answered. The segments are borrowed so the two read as the same family of indicator.

A soft-closed question counts as answered rather than reopened: it means the newest analysis stopped raising something already settled, and counting it as open would make a topic look less ready every time it regenerated. AI update rows are excluded — nobody can answer those.

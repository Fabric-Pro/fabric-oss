---
"fabric-app": patch
---

A security scan that fails at a non-AI step no longer blames the AI model: a timed-out step now reads "Gathering the project content timed out." with a retry hint.

Fizzy #2502, found in the post-ship review. The transient-cause hint was always AI-worded, so a timed-out gather step, which only reads the database, recorded "Gathering the project content failed: Activity task timed out The AI model didn't respond in time…", with a missing full stop as well. A failed scan step (starting the scan, gathering the project content, saving the results) now gets hint wording that doesn't mention the AI model, a timed-out step is described as timing out rather than as Temporal's "Activity task timed out", and the hint always starts a new sentence. The wholesale "every scanner failed" message keeps its AI-model hint.

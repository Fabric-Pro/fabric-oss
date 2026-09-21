---
"fabric-app": patch
---

Coding Instructions can now show exactly what changed between two versions, as a line-by-line diff of each changed file.

A proposal under review used to print both the old and the new copy of every changed file side by side, leaving the reviewer to find a one-line edit in a four-hundred-line rule file by eye. Each change is now a section that can be folded away, headed by its path and a `+N −N` line count, and opens onto a single unified diff of the two sides. A proposal with more than five changed files starts folded, so the approve and reject buttons stay in reach. Binary files, a side too large to send inline, and the paged reader for one all behave exactly as before.

History offers "Compare with published" on any readable version that is not the published one, which answers what would change if that version were published. The published summary says what the version changed relative to the version it was edited from, with a link into the same comparison. Both list the added, removed and changed paths first and fetch a file's text only for a row somebody opens — and a script or a settings file waits for an explicit "Show diff" even then.

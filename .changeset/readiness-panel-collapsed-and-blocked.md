---
"fabric-app": patch
---

The collapsed readiness panel keeps working, blocked items say what would unlock them, and each row's actions move into one menu.

**Collapsed, the panel used to render nothing.** The only survivor was a pill beside the project
title — far from where the panel had been, and shaped like a status label rather than a handle:
"once I collapse it, I don't know that a user would know how to unexpand it." A rail or a tab would
have restored the door alone; the real complaint was that readiness stopped existing on collapse.
It now collapses to a one-line strip in the panel's own place, carrying the level, the required
count, the progress and the next step, with the expand chevron where the collapse chevron was. The
whole strip is the target, not just the chevron. A Ready project still shows nothing, because it
has nothing to ask for.

**Blocked items now name their prerequisite.** "6 more items appear once earlier steps are done"
told a reader something was missing but never what to do about it. Hidden items are grouped by what
would unlock them and read "Complete Codebase connected to unlock Codebase explored in Atlas,
Security scan completed, Release notes configured" — the blocked-capability warning the card asks
for, informational only, never gating the action.

**Each row's actions move into a single context menu**, as FR22 and AC-9 describe, instead of a row
of inline buttons. With 26 rows those verbs were most of the panel's visual weight, competing with
the item names a reader is actually scanning.

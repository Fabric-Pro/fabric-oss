---
"fabric-app": patch
---

Readiness rows no longer show two different meanings under the word "not applicable".

Need levels rendered as raw enum text, so a row the current phase does not grade printed
`NOT_APPLICABLE` — the same words as the state a person sets by choosing Not applicable, on a row
that also offered a Not applicable button. In a Discovery project that is three rows (release
notes, Atlas, security scan) appearing to say they are already not applicable while inviting you to
mark them not applicable.

The four levels are now translated, and phase non-applicability says "Not needed in this phase" in
its own words. On such a row the snooze and Not applicable actions are withdrawn — neither changes
anything observable on an item the phase does not grade — while the call to action stays, since
running a scan ahead of the phase that requires it is a reasonable thing to want.

Guarded alongside the other readiness copy keys.

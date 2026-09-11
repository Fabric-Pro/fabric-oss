---
"fabric-app": patch
---

Make scheduled document auto-refresh actually run, and stop it reporting no changes on a document with new material waiting

The rollout switch for scheduled auto-refresh is read by two deployments, and
only the web application had it set. The background worker that performs the
hourly sweep resolved it to its registry default of off, so a document could be
enrolled, given a cadence and set to apply automatically while nothing ever
refreshed it — and because the sweep stood down before recording an attempt, the
settings panel had no last-run time or status to show for it. The worker's
deployment now carries the switch, and a sweep that stands down names the gate
that closed instead of returning an empty list in silence.

A refresh that did run then had trouble finding anything to say. The retrieval
behind it ranked candidates on similarity alone, and a document resembles the
sources it was written from far more closely than it resembles anything said
since — so on a project with months of meetings those same sources filled every
slot, the model was handed only material already in the document, and it
correctly reported that nothing had changed. Refreshes and the "Update using
context" button now reserve part of each retrieval for material created after
the document was last written.

Separately, a failed model call is no longer reported as a missing AI provider.
A rate limit, a provider error or an unparseable response used to produce the
same "check your AI settings" message as a genuinely unconfigured provider,
sending people to a settings page that was already correct.

---
"fabric-app": patch
---

Turn the Publishing Suite Inbox on by default, so publishing topics open into the two-section Inbox without an administrator enabling it

Publishing Suite 1D (Fizzy #2265). The Inbox, read/unread state and the snooze
overlay all shipped in v1.14.0 behind `PUBLISHING_INBOX`, default OFF. Everything
was in place and nobody could see it. This flips the registry default.

**The flip follows a hands-on run of the whole slice on staging**, with the flag
enabled through the admin console rather than a deploy, against a project with
real generated topics. Five things were exercised, and each was read back rather
than assumed:

- both sections render, with Recently Modified capped at three and holding only
  topics in Selected or In Progress;
- read state is set automatically when a row is opened, toggles manually in both
  directions, and survives a full page reload — the state is also carried in the
  row's accessible name, not only in the colour of a dot;
- the snooze dialog offers exactly the three fixed presets and no custom
  duration. Picking the furthest one rather than the preselected default stored a
  date three months out, which is what distinguishes "the preset was honoured"
  from "the default was written";
- the snoozed topic left the Inbox, was found under the Snoozed chip **still
  carrying its own status**, showed the optional rationale, and came back on
  un-snooze to the empty baseline captured before the run;
- the decline rationale persisted under its own heading, and the topics declined
  earlier without one render no heading at all — both halves of that requirement
  visible on one screen.

The status picker also lists exactly five statuses with no Deferred among them,
which is the user-facing confirmation that 1D-1b's contract migration reached the
dev database after the corrective migration for policy-mode RLS.

Not verified, and not claimed: automatic re-surfacing once a snooze elapses.
Three months cannot be waited out. The risk is structural rather than
behavioural — `snoozedUntil <= now()` is evaluated on read and no row is
rewritten when the moment passes, so there is nothing to drift — but that is an
argument, not an observation.

**Nothing sets `FABRIC_FEATURE_PUBLISHING_INBOX` in any deployed environment.**
There is no Bicep parameter, no workflow step and no `.env` template behind it —
every occurrence of the name is inert. So this default is what actually governs
staging and production,
which is why the flip is the change rather than an environment variable. A deploy
can still force it off through that variable, and an administrator's override
beats both.

One consequence of defaulting ON rather than OFF, recorded in the flag's
admin-facing note: `getFlagOverrides` swallows a read error from the override
table and returns an empty map, so a fault in that table specifically resolves
this flag back ON, and an administrator's OFF is not durable against it. The
same trade was accepted for the two flags that already default ON.

That degrade path carried a comment claiming the fail direction "can only turn
flags off, never on". That stopped being true when the first default-ON flag was
registered; this change corrects it rather than adding a third counterexample
beneath a false claim.

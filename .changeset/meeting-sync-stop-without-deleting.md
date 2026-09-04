---
"fabric-app": patch
---

Meetings can be stopped without deleting their transcripts, deleted meetings are recoverable for 7 days, and a broken sync is now visible and repairable.

Fizzy #2355, consolidating #2354 and #2356. Unlinking a meeting was one
destructive action standing in for two intentions — "stop syncing this" and
"delete everything we ever captured from it" — reachable by any editor behind a
popup that is easy to click through. A project lost roughly 200 meetings of
context that way.

**Stop syncing.** A single `deactivatedAt` timestamp. Nothing is deleted, and
only the sync's own lookup filters on it, which is what makes stopping
non-destructive.

**Deleting is recoverable for 7 days.** The rows are copied into a
`DeletedMeetingArchive` and then deleted for real — same cascade, same vector
purge as before. Deliberately an archive rather than a `deletedAt` on the live
rows: a soft delete would have needed a "not deleted" predicate at 100+ read
sites, six of which use `findUnique` and cannot take one, two of which must keep
SEEING deleted rows or a restore re-embeds everything, and all under a unique key
a tombstone would occupy so relinking would silently resurrect. Archiving leaves
the live tables clean, so there is no predicate anywhere to forget. Restore
rebuilds and re-embeds; a daily job purges expired archives.

**The confirmation became a fork.** It names the count at risk and offers
stopping the sync as a third action, which takes focus — so the reflex of
hitting Enter now keeps the transcripts rather than destroying them. An undo
toast catches the immediate realisation; a recently-deleted list catches the
delayed one.

**Unlinking is admin-only.** Raised from `PROJECT_UPDATE` to
`PROJECT_SETTINGS_EDIT` across meetings, Teams channels, Teams chats and Slack
channels. Deleting a single context already required PROJECT_ADMIN, so an editor
who could not delete one context could unlink a meeting and take out dozens.
Linking stays open to editors — a team member may need to add a meeting the
owner was not in.

**A broken sync is no longer silent.** The sync runs on one user's delegated
Microsoft token, frozen into the workflow's arguments and previously unreachable
from SQL. When that account went away the fetch threw, the activity swallowed it,
and the run still stamped a clean `lastRun`. Failures are now recorded and
cleared, the bound account is persisted and shown, and Reconnect rebinds the
project — after a preflight that resolves every meeting under the new account and
names the ones they cannot see, because Microsoft grants transcript access per
person and a silently narrowed sync looks identical to a healthy one.

Ships dark behind `MEETING_SYNC_CONTROLS`. Needs a temporal-worker deploy as
well as web.

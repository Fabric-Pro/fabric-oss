---
"fabric-app": patch
---

Meeting transcript sync now reads each linked meeting from the calendar of the person who linked it, instead of one account for the whole project.

Fizzy #2354. A project's scheduled sync ran under a single Microsoft account,
frozen into the Temporal workflow's arguments when sync was first enabled, and
every linked meeting was looked for in that one person's calendar. A meeting
somebody else linked was simply never found — Graph answers an unmatched
calendar query with "no meetings" rather than an error, so nothing threw,
nothing was logged, the run stamped a clean last-run, and the settings panel
went on reporting a healthy sync. Reproduced on staging: of three linked
meetings, the two linked by the bound account kept collecting; the third
captured one transcript at the moment its linker pressed Sync now, and nothing
after.

`ProjectLinkedMeeting.userId` was already written at link time and read by
nothing. It is now the sync identity: the workflow groups the project's
meetings by linker and does one calendar read per account, then fetches each
transcript under the account that linked it. Rows predating the column fall
back to the project-level account, which is exactly who was reading them
before, so nothing moves on upgrade.

- The grouped loop is behind `patched("meeting-sync-per-linker-2026-09")`, so
  executions started before this replay their single-read history unchanged
  until they continueAsNew.
- `recordMeetingSyncFailure` / `clearMeetingSyncFailures` are scoped to the
  meetings a given calendar read answered for. Unscoped, one healthy linker's
  pass cleared a departed linker's failures every cycle and the sync went back
  to looking healthy.
- The last-run timestamp is stamped when any account was readable; which
  meetings stalled is carried per row. Freezing it would describe a whole
  project as down when one linker of four has left.
- The panel names the account behind every row, the failure banner names whose
  connection needs attention, and `repairSync` takes an optional
  `linkedMeetingIds` so one meeting can be taken over without restarting the
  workflow or moving anybody else's.

Teams channels, Teams chats and Slack channels carry the identical one-token
binding and are untouched here.

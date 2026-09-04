---
"fabric-app": patch
---

Offer "Reconnect sync to me" from the sync menu at any time, not only once five consecutive failures have been recorded.

Repair had one entry point: the failure banner, which needs the app to have noticed. It cannot notice the case the feature exists for — a bound account whose token still works but has lost access to some meetings returns an empty list rather than an error, so nothing increments, no banner appears, and the project quietly collects less than it used to while looking healthy. The person who knows is the one who watched the meeting happen and sees no transcript.

Handover had no route either. There is no per-meeting owner: the sync is one workflow carrying one user's id, so rebinding the project to the clicking user is the transfer. Gating that behind the banner meant a departing colleague's project could not be moved until their account died and the sync broke.

The action leads with the existing read-only preflight, so the confirmation names the meetings the caller cannot see before anything is rebound; it is disabled with the reason shown when nothing is syncing; and it is gated on edit permission, unlike the backfill items beside it, because it changes whose account the whole project collects under.

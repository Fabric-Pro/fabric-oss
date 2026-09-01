---
"fabric-app": patch
---

Cap how many rows each Daily Brief collector returns so a busy project cannot outgrow the workflow payload limit

Fizzy #1997 follow-up. The collectors' outputs are assembled into one object that travels to the summarizer as a single message capped at 4 MiB. Four collectors (stories/tasks/versions, document changes, meeting transcripts, Teams proposals) capped per-item text but not row counts, and the pull-request collector capped 100 per repo with no limit across repos — so a project with many connected repos multiplied straight through. Every query is ordered newest-first, so the caps keep the most recent activity, which is what a brief shows anyway (the prompt itself only ever renders 25 per source).

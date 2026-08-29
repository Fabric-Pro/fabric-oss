---
"fabric-app": patch
---

Recover a channel meeting's transcript from its recording even when Microsoft Graph refuses to look the meeting up

Delegated Graph resolution is organizer-scoped. An attendee of a Teams channel meeting
gets `403 Forbidden — "3003: User does not have access to lookup meeting"` from
`get_meeting_by_join_url`, and that refusal used to end the sync immediately. The
channel-meeting recording fallback then never ran, because it sat behind a *successful*
lookup — even though it resolves entirely from the join URL (thread id → joined teams →
channel → filesFolder → Recordings) and needs no Graph meeting id at all. The one path
that could still reach the transcript was gated behind the one call an attendee can
never make.

Observed on staging: a linked channel meeting matched its calendar occurrence, then
failed at `fetchAndStoreMeetingTranscript` with the 403 while the transcript and
recording were both plainly present in the channel's SharePoint site.

For a channel meeting, every way Graph can decline — a 403, a thrown transport error,
or the empty 200 it returns even to the organizer — now leads to the same place: try the
recording. An ordinary meeting has nowhere else to look, so its failure stays fatal and
is reported unchanged.

Two supporting changes:

- When Graph never names the meeting, the transcript is filed under `channel:<threadId>`.
  The thread id is stable across every occurrence of that channel meeting, so it
  preserves exactly the grouping Graph's online-meeting id provided — and that id is
  half of the `(projectId, meetingId, transcriptId)` unique key as well as a grouping key
  read by the architecture-decisions and publishing-suite queries.
- `hasTranscriptNearOccurrence` is now scoped by `linkedMeetingId` rather than
  `meetingId`. `meetingId` is no longer stable across sources, so keying occurrence
  coverage on it would let one occurrence be ingested twice — once under Graph's id and
  once under the channel's. The link is one row per meeting per project whatever Graph is
  willing to say, which is what an occurrence actually belongs to.

  This closes the reachable double-ingest path, not every conceivable one. The guard sits
  inside the fallback branch, so a channel meeting that Graph both resolved *and* served
  transcripts for would skip it, and the transcript-id check would not match rows already
  filed under `channel:<threadId>`. Graph returns an empty list for every resolvable
  channel meeting today — that is the whole reason the fallback exists — so the case does
  not arise; it is written down because the guard does not cover it.

Worker-only change (no schema, no API surface), so it needs a temporal-worker deploy —
Vercel alone will not carry it.

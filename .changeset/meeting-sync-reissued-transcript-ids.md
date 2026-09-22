---
"fabric-app": patch
---

Meeting transcript sync no longer stores a meeting occurrence a second time when Microsoft Graph reissues its transcript under a new id, so the Proposal Inbox stops filling with suggestions re-analyzed from months-old meetings.

Graph can hand back a new transcript id for an occurrence that was already synced. The id-keyed dedupe let it through as new, which re-stored the transcript as extra meeting context and started auto-analysis again for every affected occurrence (Fizzy #2617). Every listed transcript is now also checked against the occurrences the linked meeting already covers, the same six-hour window the channel-recording fallback uses, decided before anything is stored so two transcripts listed together for one occurrence are both kept within one successful sync attempt.

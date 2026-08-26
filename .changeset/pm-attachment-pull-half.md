---
"fabric-app": minor
---

Import GitLab attachments back into Fabric, completing bidirectional attachment sync

Fizzy #1745 shipped one direction. Pushing worked; pulling did not exist, so a
card titled "bidirectional GitLab attachment sync" left five of its eleven
acceptance criteria (AC-5 through AC-9) with no implementation behind them.
`StoryAttachmentSyncIssue` had been in the schema since #1702 with no reader
and no writer, because the half that would have written to it was never built.

With `FABRIC_FEATURE_PM_ATTACHMENT_SYNC` on and a project opted in, a GitLab
pull now:

- imports attachments the issue carries but Fabric does not, as unlocked
  PM_SYNCED rows (AC-5);
- skips ones it already holds, recognised first by the stored handle and then
  by content hash, so a re-upload under a new secret is still not duplicated
  (AC-6);
- keeps Fabric's copy and records a discrepancy when a previously-pulled file
  is no longer on the issue — deletions never propagate (AC-7);
- records a conflict, and changes neither side, when a filename matches but
  the content hash does not (AC-8);
- refuses files over #1702's configured limits and notifies the user with the
  file and the limit named (AC-9).

Attachments imported this way land unlocked, which deliberately differs from
the upload path's locked default: an uploaded file is one someone chose to
add and may not want shared, whereas a pulled one is already visible on the
issue it came from.

Two behaviours worth knowing about. Inline images are untouched — the existing
image-sync path already re-hosts those, and the importer explicitly ignores
image embeds so a pull cannot import the same picture twice. And the importer
enforces the MIME allowlist and the per-story cap as well as the size limit;
only the size limit is required by an acceptance criterion, but an importer
that skipped the other two would be a second door into the attachment store
with controls the upload path enforces missing.

Limits now resolve from one shared module rather than two copies, since the
Temporal pull path and the API upload path have to agree on the numbers.

Off by default. The feature flag and the per-project toggle both still gate
every part of this.

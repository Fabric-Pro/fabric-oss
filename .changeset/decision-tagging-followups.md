---
"fabric-app": patch
---

Decision ownership now rejects non-members, survives version reverts safely, and stops re-notifying the owner on every save.

Fizzy #2029 post-ship review follow-ups.

Security:
- Version revert restored a snapshot's owner without re-checking membership, handing accountability (and a notification naming the decision) to someone who had left the project. The restored owner is now cleared when they are no longer an active member.
- Owner validation accepted any project_member row, so a pending invitee or expired guest could be made owner and notified. Now uses the roster's own predicate (acceptedAt set, not expired), extracted as `isActiveProjectMember`.
- Meeting-ingestion loaded the roster before the model call and wrote the owner seconds later; membership is now re-checked immediately before the write.

Cost:
- The owner-notification dedupe key embedded `currentVersion`, which bumps on every save, so it never coalesced — a burst of edits produced one email/webhook/workflow per save. Keyed on (decision, owner) now, matching the subscription-update pattern.

Structure:
- Ownership helpers moved to `lib/decision-owner.ts` (removes a procedure-to-procedure import; crud.ts back under the size guard).
- Roster loading for AI suggestions shared via `loadSuggestionContext`; the tag pill stack shared via `DecisionTagPills`.
- Removed unused `isNewType` / `includeArchived` surface.
- The prompt-sync migration's replace() anchors are now pinned by a test, so drift fails CI instead of silently no-opping on deploy.

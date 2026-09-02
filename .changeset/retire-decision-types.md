---
"fabric-app": patch
---

Let a project retire a decision type it no longer uses, and keep the label on decisions that already carry it

Closes the two items left open by Fizzy #2029.

The taxonomy could grow but never shrink: a type minted by a typo, or by the AI
at meeting-capture, was permanent, which contradicted AC1's "evolving" taxonomy.
The `archivedAt` column and the `archivedAt: null` filter in `listDecisionTypes`
already existed — only the mutation was missing — so this ships archive rather
than delete. Nothing is detached and nothing cascades: the decision list and
detail reads resolve `decisionType` through a plain relation with no archive
filter, so a retired type keeps rendering its historical label on the decisions
that already carry it, and only the picker stops offering it. Retiring is
undoable from the toast, so a mistake does not require re-tagging a decision to
recover. Reachable from a "Types" dialog on the decision log, gated on the same
permission as deleting a decision.

Version snapshots are a deliberate non-change: `ArchitectureDecisionVersion`
stores `decisionTypeId` as a bare column with no relation, and no version view
renders a type today, so there is no historical label to preserve there.
Archiving rather than deleting is what keeps that stored id resolvable if a
future change ever surfaces it — a hard delete would have orphaned it.

Also fixes a collision that shipping archive would have made reachable:
`ensureDecisionType` matched live rows only, but `@@unique([projectId, name])`
spans archived rows too, so re-applying an archived name hit P2002 and the
recovery read handed back the archived row — quietly tagging a decision with a
type no picker shows. Re-applying a name now revives the original row, which is
also what the user means by it. Five regression tests, each watched failing
against the pre-fix code first.

The second item was a verification gap rather than a defect, and it closed
without a product change: the owner-notification write path was unit-tested
only, and could not be observed on a shared environment because the actor is
deliberately skipped (a self-assignment writes nothing) and one account cannot
read another's inbox. A new integration test against a real Postgres pins the
behaviour that was never observed — a row addressed to a *different* member,
typed DECISION_OWNER_ASSIGNED, keyed `decision-owner:<decision>:<owner>` so a
burst of edits coalesces to one unread row instead of re-emailing on every save.

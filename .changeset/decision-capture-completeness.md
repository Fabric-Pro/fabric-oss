---
"fabric-app": patch
---

Require a type and duration when capturing a decision, record where it came from, and let the owner acknowledge it

Closes the three gaps an independent audit of Fizzy #2029 found between the
shipped feature and the card's own acceptance criteria.

**AC1 was not enforced.** The criterion says a saved decision must have an
assigned type and a duration classification. Both were `.nullable().optional()`
with nothing rejecting null, so every decision could be saved completely
untagged — demonstrated by creating one through the deployed API and getting a
200 back. Create now requires a duration and a type (as an existing id or a new
label to mint), refused at the schema with a message naming the missing field.
Editing stays permissive on purpose: decisions captured before this rule must
still be openable and correctable, and the meeting-ingestion path creates its
draft through the query layer before the AI tags it.

**AC3/UC2 asked for approval, not just notification.** The owner was told a
decision was theirs; nothing recorded that they accepted it, so "has the owner
signed off?" had nothing to query. Adds `ownerAcknowledgedAt`, an owner-only
`acknowledge` procedure, and an Acknowledge action on the decision sheet that
becomes an "Owner acknowledged" chip. The guard is the query itself — the row is
matched on `ownerUserId`, so a non-owner cannot acknowledge even if the
procedure let them through. Acknowledgement is cleared when the decision is
handed to a different owner, since the new owner has accepted nothing, and
reassigning to the same person leaves it standing.

**FR4 had provenance on only one of the two capture paths.** Meeting-extracted
decisions carried `sourceKind` and rich `sourceMetadata`; manually captured ones
had no source field at all and were `sourceKind: null` forever. Manual capture
now records `sourceKind: "manual"` plus an optional reference naming the ticket
or feature behind the decision.

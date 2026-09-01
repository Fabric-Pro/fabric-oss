---
"fabric-app": patch
---

Repair documents whose organization was left unset, so auto-refresh stops reporting a document it just rendered as missing

Fizzy #2210, second half. The first half made the failure legible; this is what
the legible failure turned out to say.

**The symptom, once the error stopped being swallowed.** Enabling auto-refresh
returned `NOT_FOUND: Document not found` for a document that was on screen,
that the document list had returned, and that the caller could open and edit.
Two procedures disagreed about whether it existed: everything project-scoped
found it, and the auto-refresh gate did not.

**Why they disagreed.** A document's organization is a denormalized copy of its
project's, and `createDocument` copied it from the creating session instead.
A session whose own organization failed to resolve passed `undefined`, and the
row was written with a null organization inside an organization-owned project.
`listDocuments` filters on `projectId` alone — isolation there is the project
permission check upstream — so the row stayed fully visible. The auto-refresh
gate compares the document's tenant against the caller's exclusively, per the
XOR rule, and a null matches no organization at all. Not the caller's, not
anyone's: the document was unreachable through that gate for every member of
the organization that owned it. Project role had nothing to do with it, which
is why an owner saw the same failure as everyone else.

**The gate is right and is unchanged.** It answers `NOT_FOUND` rather than
`FORBIDDEN` on a tenant mismatch precisely so it cannot confirm to an outsider
that a guessed id names a real document. That property is preserved here,
including on the new path: a caller who is not in the project still gets
`NOT_FOUND`, never the `FORBIDDEN` that would tell them the document exists.

**Two changes, one at each end.** `createDocument` now reads the organization
from the parent project inside the same transaction, and no longer accepts one
from the caller — a parameter that is silently ignored is worse than none, so
it is gone from the signature rather than left as a decoration. And a document
that was already written wrong is adopted into its project's organization when
someone opens it or touches its auto-refresh setting, carrying its version
snapshots across in the same transaction so a document's history cannot end up
filed under a different tenant from the document.

Healing on access rather than by migration is deliberate: the rows repair
themselves at the moment someone needs them to work, and the fix ships with the
code instead of requiring a production database session.

**The repair runs in one direction only, structurally.** It fills a null from
the project; it never rewrites or clears an organization a document already
has. The `organizationId: null` in the WHERE clause makes that a compare-and-set
rather than a matter of reading the code correctly, so a row that gained an
organization between the read and the write keeps it. A repair that could
overwrite a populated tenant would be a cross-tenant write dressed as a fix —
the exact thing the gate above it exists to prevent.

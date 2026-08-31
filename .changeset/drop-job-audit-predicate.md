---
"fabric-app": patch
---

Stop the personal-context drop job deleting audit rows that were never personal, and tell the operator when a signup could not get an organization

Two review findings, both real, both verified in the tree before being fixed.

**The drop job's audit predicate.** On `--all` with no Phase A refusals it degenerated to a bare `{ organizationId: null }`. That is the correct reading of "personal" on every other model here and the wrong one on this table: `AuditLog.organization` is `onDelete: SetNull` precisely so an organization's trail outlives the organization, `actorType` includes `system` for rows with no user at all, and a refusal row carries a null tenant deliberately — the named organization goes in `metadata` as evidence, because the caller had no standing in it. The deletion runs inside a transaction that sets `app.audit_allow_delete = 'on'`, so the tamper-evidence trigger is suspended and nothing would have stopped it.

The predicate now refuses ownerless rows and the refusal evidence outright. What it cannot separate — an in-scope user's rows from an organization that was later deleted — is undecidable from the row, so deleting anything it selects takes a `--drop-audit` switch of its own rather than riding on `--apply`.

Both predicates moved into the shared module and now have tests. The job had none, and the single place that did not read from the shared helper is exactly where this went wrong. A second finding fixed alongside: `scope()` spread a fresh `userId` over `personalWhere`'s output, discarding the ownerless-row guard on all 97 nullable-owner models — global rows survived only because SQL's `IN`/`NOT IN` exclude NULLs, an accident of the operator rather than the predicate.

**`ensureUserHasOrganization` conflated two outcomes.** It returned `null` for both "already belongs somewhere" and "creation failed". The signup hook guessed wrong in the common case: an invited user arrives already holding a membership, so every invited signup logged that they had no organization and that MCP defaults would seed on their next sign-in — false in both halves, on the happy path. It returns a discriminated outcome now, and the previously bare `catch` logs, because an account that lands there is in the fail-closed state this work exists to remove.

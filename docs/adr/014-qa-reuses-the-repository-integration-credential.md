# ADR-014: QA Reuses the Project's Repository-Integration Credential, Whatever Its Kind

- **Status**: Accepted
- **Date**: 2026-07-29
- **Deciders**: Engineering team
- **Audience**: Engineers working on QA ingestion auth, or diagnosing an empty sync
- **Owner**: Fabric platform
- **Supersedes in part**: ADR-004's scope statements, for the QA surface only

## Context

ADR-004 (2026-03-27) established project-level repository integrations for
**read-only code context**, with GitHub on OAuth, Azure DevOps on a PAT, and
GitLab explicitly deferred. QA arrived later and needs provider access for a
different purpose: reading test results, and — for the trigger feature —
starting a run.

That creates a decision ADR-004 never faced: does QA get its own credential, or
reuse the one already attached to the project?

A separate QA credential is tempting on least-privilege grounds. It is also a
second thing to obtain, store, encrypt, rotate, expire and explain, attached to
the same repository, and in practice issued by the same person from the same
provider account. Two credentials for one repo is not half the blast radius; it
is two blast radii and twice the expiry surface, with a new failure mode where
one works and the other has silently lapsed.

The genuinely load-bearing fact is that **QA's required scopes are strictly
wider than ADR-004's read-only ruling**, and pretending otherwise is what makes
an empty sync so hard to diagnose:

| Provider | QA needs |
|---|---|
| GitHub | Actions: read (results); Actions: read **and write** to start a run |
| GitLab | `api` |
| Azure DevOps | **Test Management: Read**; Build (read and execute) to start a run |

Azure DevOps' `Test Management: Read` is the single most common cause of a sync
that connects, reports success, and returns nothing.

## Decision

**QA reuses the project's existing `ProjectRepositoryIntegration` credential.
There is no separate QA credential, and QA does not care whether it is an OAuth
token, a GitHub App installation token or a PAT.**

Consequently:

- ADR-004's "v1 is read-only" statement no longer describes the whole system.
  Starting a CI run is a deliberate write, gated behind an explicit user action
  and the scopes above.
- ADR-004 listed GitLab as deferred. GitLab is a shipped first-class QA
  provider.
- Because the credential is shared, a scope missing for QA presents as a QA
  failure while code indexing keeps working — which is exactly why the required
  scopes are documented per provider and surfaced in the empty-sync guidance
  rather than left to inference.

This ADR does not change how credentials are obtained, stored or encrypted; it
records that QA is a second consumer of one credential and what that costs.

## Consequences

**Good.** One connection to make, one to renew, one to revoke. A repo that works
for code context is already most of the way to working for QA. No new secret
storage.

**Bad.** The credential is broader than either feature alone would need, so
least privilege is weakened by design. Revoking access for QA revokes code
indexing too — there is no per-feature revocation. An expiring token breaks two
features at once. And the scope requirements are per-provider trivia that a user
cannot discover from an error message alone; the ADO Test Management case in
particular fails *quietly*.

**Revisiting this** is warranted if QA ever needs a scope a code-context user
would refuse — at that point the shared credential stops being a convenience and
starts being a reason people decline the integration entirely.

## References

- ADR-004 — the original read-only, GitHub-OAuth/ADO-PAT ruling this narrows
- `docs/qa/pipeline-results.md` — per-provider scopes and diagnosing an empty sync

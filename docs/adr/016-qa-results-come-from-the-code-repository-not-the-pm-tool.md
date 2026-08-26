# ADR-016: QA Test Results Come From the Code Repository, Not the PM Tool

- **Status**: Accepted
- **Date**: 2026-07-29
- **Deciders**: Engineering team
- **Audience**: Engineers working on QA ingestion; support engineers diagnosing a project that reports no test results; PMs reading card 1834 against what shipped
- **Owner**: Fabric platform

---

## Context

Card 1834 ("Pull Automated Test Pipeline Results from PM Tools and Code
Repositories into Fabric QA Tab") is worded as though a project-management
connection is a source of test results. Its first acceptance criterion opens
"GIVEN a project with a connected PM tool (ADO) that has test runs recorded",
FR1 says results are fetched "from connected PM tools (ADO confirmed; Jira and
GitLab subject to API capability confirmation)", and the card carries an open
question asking which Jira test plugin — Zephyr or Xray — Fabric should support.

That framing does not survive contact with the integrations.

Fabric connects to Azure DevOps in two independent ways: as a **PM tool** (over
MCP, for work-item sync) and as a **code repository** (`ProjectRepositoryIntegration`,
Settings ▸ Development). A customer reasonably reads these as "we connected Azure
DevOps" — one system, one connection. They are not the same connection, they do
not share a credential, and only the code-repository one can list Test Runs.

Jira is worse: its native API exposes no test-run results at all. Retrieval
requires a third-party app (Xray, Zephyr), each with its own API surface,
licensing, and data model. The card's own open question — which plugin, if any,
customers use — was never answered, because there is no answer that covers the
customer base.

The practical consequence is a support trap. A project with Azure DevOps
connected as a PM tool, and no repository connected, has *a working Azure DevOps
integration* and *no possible source of test results*. An empty list sends
somebody to re-check a connection that is functioning perfectly well at its own
job.

## Decision

**Test results are read from the connected code repository only.** The PM
connection is not a result source and will not become one.

Concretely:

- Ingestion reads from `ProjectRepositoryIntegration` (GitHub Actions, GitLab CI,
  Azure DevOps Repos), reusing that integration's credential — see ADR-014.
- Azure DevOps results *do* work, via the ADO **code-repository** integration
  holding a PAT with **Test Management: Read**. This is the commonest
  misconfiguration: a Code-only PAT lists no Test Runs and yields a permanently
  empty sync.
- Card 1834's FR1 and its first acceptance criterion are **rescoped** to "results
  come from the code repository". They are not deferred and not partially met;
  the requirement as literally written is withdrawn.
- No PM test-management fetcher will be built. The Jira plugin open question is
  closed as "not in scope" rather than left pending.
- `providers/jira-xray.ts` remains: a tested payload mapper with no fetcher and
  no caller. It is intentionally unwired, not dead code, and should not be
  deleted — it is the cheap half of Xray support should a customer ever justify
  the expensive half.

**The product owes the user an explanation, not silence.** A project whose PM
tool is connected but whose repository is not gets a named reason in
Settings ▸ Testing — "Azure DevOps is connected as a project-management tool,
which cannot return test runs" — composed server-side in `lib/qa-result-source.ts`
and returned by the sources endpoint, so the browser holds no second copy of the
distinction. This is what card 1834's FR6 ("unsupported indicator rather than
failing silently") actually means in practice.

## Alternatives Considered

**Build a PM test-management fetcher for Azure DevOps.** Rejected: it duplicates
the repository fetcher against a second credential and a second API for the same
data, and doubles the surface where an empty sync can originate. The ADO Test
Runs API is reachable from the repository integration already.

**Support Xray and/or Zephyr for Jira.** Rejected for now. Two more third-party
APIs, each licensed separately, to serve a customer need nobody has confirmed.
The mapper is kept so the decision is cheap to revisit; the fetcher is the
expensive part and waits for a real customer.

**Show a plain empty state everywhere.** Rejected. An empty state that cannot
distinguish "nothing connected" from "the thing you connected cannot do this" is
the specific failure this ADR exists to prevent.

**Accept the card's wording and mark FR1 partially met.** Rejected as dishonest
bookkeeping. The requirement as written describes a system Fabric will not build;
saying so plainly is better than a permanently amber line in a traceability
matrix.

## Consequences

- A customer must connect a **code repository** to see test results. Connecting
  a PM tool alone is never sufficient, and the product now says so by name.
- Azure DevOps customers need a PAT scoped to **Test Management: Read** in
  addition to code access. This should be the first thing checked when an ADO
  sync returns nothing.
- Card 1834's traceability is honest: FR1/AC1 are recorded as rescoped by this
  ADR rather than as met or outstanding.
- Should a customer ever justify Jira test-management support, the work is a
  fetcher and a credential path — the normalisation mapper already exists and is
  tested.
- Anyone reading card 1834 without this ADR will conclude the implementation
  missed its first acceptance criterion. That is the risk this record exists to
  retire.

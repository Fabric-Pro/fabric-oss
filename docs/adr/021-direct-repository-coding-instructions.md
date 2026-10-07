# ADR-021: Read repository coding instructions directly from Git

Keep Git authoritative for repository instructions and read their content on demand.

- **Audience**: Projects and platform engineers
- **Owner**: Projects / Platform team
- **Status**: Accepted
- **Date**: 2026-10-06
- **Deciders**: Repository feature owner

## Context

Repository instructions previously passed through a scheduled import, content
validation and snapshot publication before readers could access them. This
duplicated Git state and made freshness depend on a separate workflow. A native
checkout must preserve its tracked bytes, index and local edits when connected.

## Decision

For ordinary REPOSITORY mode, Fabric stores the connection, branch, folder and
exclusion policy. It resolves the branch once per logical read, returns a commit
and configuration-generation pin, lists bounded file metadata, and reads a file
only when requested. It does not import, scan, copy or publish repository files
into a Fabric snapshot. File pages and commit history use the immutable pin.

The UI shows native commit history and open pull requests targeting the configured
branch. Editing, diffs, PR creation, review and merge remain with the Git provider.
Connect your agent configures Fabric MCP through its ordinary sign-in flow.
Optional CLI setup adopts a matching native checkout without changing tracked
files or Git state. Its session hook reports a behind checkout; Git owns updates.

Every read requires live project access and instruction-read permission. Provider
results and failures are fenced against access revocation and configuration
changes. Requests carry cancellation and bounded response limits. Repository
credentials remain server-side. The former aggregate snapshot size limit does
not govern direct reads; tree and individual file bounds still apply.

UPLOAD mode retains snapshot publication. An upload-to-repository migration may
perform its first import only while a validated SWITCHING pointer binds that
project, organization and sync. Already admitted workflows can settle through
their existing recovery paths. New ordinary repository imports and Fabric
proposal/commit admissions are refused, including at the database boundary.
Living Memory repository ingestion is a separate feature and remains unchanged.

## Alternatives Considered

- Optimizing snapshot imports would retain duplicate content and publication
  state between Git and readers.
- A durable content cache would require invalidation and another freshness
  contract. Request-local metadata and the client's pinned query cache are enough
  for this feature.
- Implementing a second Git editor and PR lifecycle would duplicate provider
  behavior and increase write and recovery obligations.

## Consequences

Git changes become visible after refreshing the branch pin; no import job must
finish first. Fabric availability depends on provider availability and current
credentials. Provider latency and rate limits still apply, so direct reads are
not guaranteed to match a local Git command's speed. Existing snapshot data is
retained for upload flows and recovery; this cutover does not delete historical
data. GitHub, GitLab and Azure DevOps use their native read APIs through the shared
repository connector boundary.

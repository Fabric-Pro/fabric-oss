# ADR-019: Agent guidance uses routing, progressive disclosure, and enforcement

- **Status**: Accepted
- **Date**: 2026-09-10
- **Deciders**: Engineering team
- **Audience**: maintainers of repository instructions and automation
- **Owner**: Engineering team

## Context

The root `AGENTS.md` grew into a 69 KiB handbook. Codex loads project
instructions under a combined byte budget and, at its default 32 KiB limit,
truncated this file halfway through a tenancy heading. Release, changeset, and
delivery requirements later in the file were therefore absent from the active
instructions. The file also duplicated detailed documentation that had drifted
from accepted ADRs and current code.

Markdown links, nested instruction files, skills, command rules, and CI checks
solve different parts of this problem. A link is useful routing but is not an
automatic include. Codex discovers nested `AGENTS.md` files according to its
working path, while Claude Code discovers nested `CLAUDE.md` files instead.
Skills are loaded on demand. Command rules can restrict shell execution but
cannot enforce code architecture. CI is the reliable cross-agent enforcement
layer.

## Decision

Repository guidance uses five layers:

1. Root `AGENTS.md` contains repository-wide invariants and an imperative
   routing table. It remains below 20 KiB so critical instructions fit beneath
   Codex's default project-document budget with room for nested guidance.
2. Root and path-specific `CLAUDE.md` files import their neighboring
   `AGENTS.md`. The root shim may also contain Claude-specific behavior; nested
   shims stay import-only so shared policy remains canonical.
3. Accepted ADRs, `fabric/standards/`, and canonical topic documentation hold
   detailed rationale and examples. Routing text says when they must be read;
   links alone are never treated as includes.
4. Repository skills under `.agents/skills/` hold repeatable procedures that
   benefit from progressive disclosure.
5. Deterministic checks and project-local Codex command rules enforce
   machine-checkable policy. CI is authoritative across coding agents; Codex
   rules are an additional local safety boundary.

Critical security, tenancy, release-decision, public-identifier, and DCO rules
remain in the root instructions even when detailed documents also cover them.
No critical invariant depends solely on implicit skill activation, a nested
instruction file, or an untracked local file.

## Alternatives considered

- Keep one comprehensive root handbook and raise the loader byte limit. This
  preserves a single file but continues to spend every session's context on
  path-specific detail and leaves other agents dependent on matching local
  configuration.
- Put nearly everything in nested instruction files. This keeps the root tiny
  but does not protect sessions that start at the repository root, so it is not
  suitable for cross-cutting safety and delivery rules.
- Generate the instruction bootstrap from another source. Generated guidance
  can work, but it adds tooling and makes the active repository policy less
  obvious in ordinary code review. A checked-in canonical root plus a small
  compatibility shim is simpler here.

## Consequences

- Root instructions become a maintained control plane instead of a reference
  manual.
- Detailed guidance can evolve without consuming every agent session's initial
  prompt.
- A validator rejects instruction growth, broken routing links, loss of
  required root invariants, and missing Claude compatibility shims.
- Changeset decisions are explicit: an impacting change carries a non-empty
  changeset, while a genuinely non-impacting change uses `skip-changeset`.
- `project_doc_max_bytes` may be raised locally as a temporary compatibility
  measure, but it is not the repository's primary defense against instruction
  bloat.

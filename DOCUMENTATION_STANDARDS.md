# Documentation Standards

Non-negotiable rules for all documentation in this repository.

---

## Core Rules

1. **Documentation is authoritative knowledge, not history.** Git history is the record of change evolution.
2. **No work logs.** Do not commit debugging sessions, fix summaries, or iteration narratives as markdown files.
3. **No execution plans after completion.** Delete plans once work is done. The code is the outcome.
4. **No duplicate topic files.** One topic = one file. Update the existing file instead of creating a variant.
5. **Every document must define its audience and owner** in a metadata header.
6. **Files must live in approved directories** (see Directory Structure below).

## Prohibited Patterns

Do not create files matching these patterns in any directory:

- `*_FIX.md`, `*_FINAL.md`, `*_COMPLETE.md`
- `*_TRY.md`, `*_UPDATED.md`, `*_V2.md`
- `*_REVISION.md`, `*_DRAFT.md`
- `*_PLAN.md` (unless actively in progress)
- `*_GAPS.md`, `*_COMPARISON.md`, `*_ANALYSIS.md`

These suffix rules apply to all directories. ADRs follow their own naming convention (`docs/adr/NNN-decision-title.md`) and are exempt from these rules.

If a document describes "how we fixed X" or "what we tried", it does not belong in the repository. Put that information in a PR description or commit message.

## AI Usage Policy

- AI must update canonical documents, not create variants.
- AI must not generate iteration files (`_V2`, `_FINAL`, `_TRY`, `_UPDATED`).
- AI must not produce debugging narrative markdown.
- AI output is ephemeral unless explicitly promoted to a canonical document by human review.

## Required Document Header

Every markdown file (except README.md, CONTRIBUTING.md, SECURITY.md) must start with:

```markdown
# Title

One-line description.

- **Audience**: [who reads this]
- **Owner**: [team responsible]
```

## Directory Structure

Product and developer documentation must live in approved directories:

| Directory | Purpose | Rules |
|-----------|---------|-------|
| `/` (root) | Entry points | README, AGENTS, CLAUDE, CONCEPTS, CONTRIBUTING, SECURITY, CHANGELOG, COLLABORATION only |
| `docs/` | Internal developer documentation | Architecture, deployment, integration references |
| `docs/adr/` | Architecture Decision Records | Numbered, immutable once accepted |
| `agents/docs/` | Agent-specific documentation | Architecture and protocol references only |
| `agents/langchain/*/` | Per-agent READMEs | One README per agent |
| `apps/web/content/docs/` | Public documentation site | User-facing fumadocs content |
| `apps/web/content/posts/` | Blog posts | Published content only |
| `fabric/standards/` | Coding standards | Active standards only |
| `deployment/` | Deployment references | Per-platform guides |

**Exceptions**: Tooling and CI configuration directories (`.github/`, `.claude/`, `.augment/`) may contain markdown files as needed for their respective tools. These are not subject to this rule.

Do not create product or developer documentation markdown files outside the approved directories listed above.

## Architecture Decision Records (ADRs)

When a document represents a lasting architectural decision, it must be an ADR.

Location: `docs/adr/NNN-decision-title.md`

Required format:

```markdown
# ADR-NNN: Decision Title

- **Status**: Proposed | Accepted | Deprecated
- **Date**: YYYY-MM-DD
- **Deciders**: [names]

## Context
[Why this decision was needed]

## Decision
[What was decided]

## Alternatives Considered
[What else was evaluated]

## Consequences
[What this means going forward]
```

## CI Enforcement (Policy)

CI should fail if:

- Files match prohibited patterns (`*_FIX.md`, `*_FINAL.md`, etc.)
- Markdown files are added outside approved directories
- Markdown files are missing the required metadata header
- Multiple new docs are created for the same topic without an ADR

## Review Checklist

Before merging any PR that includes markdown files:

- [ ] No temporary or iteration documentation added
- [ ] Existing canonical docs updated (not duplicated)
- [ ] ADR created if architecture changed
- [ ] Document has audience and owner defined
- [ ] File is in an approved directory

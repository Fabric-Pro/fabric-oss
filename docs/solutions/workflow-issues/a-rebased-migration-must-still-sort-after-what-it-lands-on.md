---
title: "A rebased migration must still sort after everything it lands on"
date: 2026-09-25
last_updated: 2026-09-28
category: workflow-issues
module: database prisma migrations
problem_type: workflow_issue
component: database
severity: medium
applies_when:
  - "Rebasing a branch that adds a Prisma migration onto a trunk that gained migrations since the branch was cut"
  - "A long-lived feature branch whose migration was generated days before it will merge"
  - "Reviewing a PR whose migration directory name sorts before the newest migration on master"
tags: [prisma, migrations, rebase, migration-order, git-fixup, autosquash, database]
related_components: [database, git]
audience: Anyone carrying a Prisma migration on a branch across one or more rebases
owner: Fabric platform
---

# A rebased migration must still sort after everything it lands on

## Context

The Glossy edition branch added one migration: six tables and their RLS. The branch lived for several days while master kept merging migrations, and each rebase brought in new directories whose timestamps were **later** than the branch's migration. The migration was renamed three times before it ended up as `20260928073600_glossy_editions`, sorting after master's newest one (`20260927120000_...`). The third rename came after the PR was already open and green: while it waited three days for its relay, master gained 86 commits and six migrations.

A rebase changes nothing about this on its own. Git replays the branch's commits on top of the new base, and the directory name, which is where the timestamp lives, goes through untouched. The branch's history now claims its migration came *after* master's newer ones, while the filenames claim it came *before* them.

## Guidance

**After every rebase that brings in migrations, check that the branch's migration is last:**

```bash
ls packages/database/prisma/migrations | grep -v migration_lock | sort | tail -3
```

If it isn't, rename it to a timestamp later than the newest migration on the new base.

**Rename only a migration that no shared database has applied.** Re-timestamping is safe on an unmerged branch, and nowhere else. A migration that has reached staging or production is never renamed or edited (see `AGENTS.md`, Database and migration safety).

**Fold the rename into the commit that introduced the migration,** so that history shows it created once under its final name, rather than created and then moved:

```bash
M=packages/database/prisma/migrations
git mv "$M/<old-timestamp>_glossy_editions" "$M/<new-timestamp>_glossy_editions"
git commit -s --fixup=<sha-of-the-commit-that-added-it>
git rebase --autosquash <sha-of-the-commit-that-added-it>~1
```

Git 2.44 and later apply `--autosquash` to a non-interactive rebase, which matters here because interactive rebases (`-i`) aren't available in agent sessions. If the fixup is not signed off, the combined commit keeps the sign-off of the commit it is folded into.

**Re-run the migration against a scratch database afterwards, not your working one.** A local database that applied the migration under its old name now has a migration that is missing from the directory. `prisma migrate status` reports it, and `migrate dev` may offer to reset the database to reconcile. Apply the full history to an empty scratch database instead (the command is in the generated-migration learning under Related).

## Why This Matters

Prisma applies pending migrations in directory-name order, and a fresh database (CI, a shadow database, a new environment) replays the **whole** directory in that order. Production doesn't: it applied master's migrations when they merged, and applies the branch's migration when the branch merges. If the branch's migration sorts before master's newer ones, the two kinds of database apply the same set in **different orders**.

Most of the time that makes no difference, because the migrations touch different tables. When it does make a difference, it fails in the worst place. A migration that depends on an object a later-named one creates (or the reverse) works in production and fails on every fresh database, or it produces a schema that differs between environments with nothing to show why. Keeping the branch migration last keeps name order and application order the same, which is the assumption the whole directory depends on.

This is a smaller, mechanical sibling of the generated-migration learning: both are about a migration that looks right in the diff and is wrong about its surroundings.

## When to Apply

- Every rebase of a branch that carries a migration, not only the first. This branch needed three renames.
- Before publishing a PR that has been waiting. A green PR goes stale in the same way while it waits for review or relay, and the final rebase before publication is where the check matters most.
- Just before opening or updating the PR, as part of the final rebase onto `origin/master`. Local `master` may be stale; compare against the remote.
- In review: a PR whose migration sorts before master's newest migration needs a rename before it merges.

## Examples

The migration was generated as `20260924162758_glossy_editions` and renamed to `20260924190000_...` after the first rebase. The second rebase brought in two more master migrations, and it was in the middle again:

```
20260924190000_glossy_editions                                <- branch, after its first rename
20260924210400_instruction_snapshot_pr_confirmation_due_idx   <- master
20260924210500_instruction_snapshot_pr_refresh_admitted_at    <- master
```

After the fixup and autosquash, it sorted last as `20260924220000_glossy_editions`. Three days later, with the PR still waiting for its relay, the pre-publication rebase brought in six more master migrations (`20260926193700_...` to `20260927120000_...`), and the same fixup moved it again:

```
20260927100300_instruction_snapshot_proposal_branch_validate
20260927120000_context_repository_sync_excluded_paths
20260928073600_glossy_editions
```

Each time, the foundations commit shows the migration as `A` (added) under its final name, with no rename in history.

## Related

- `docs/solutions/developer-experience/a-generated-migration-diffs-the-schema-not-your-change.md`: reading what `migrate dev` generated, and proving a migration applies on a scratch database.
- `fabric/standards/backend/migrations.md`: migration standards.

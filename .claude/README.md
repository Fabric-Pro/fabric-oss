# Claude Code hooks

This directory holds the team-shared **PreToolUse hooks** that enforce
the safety rules documented in `CLAUDE.md` and `CONTRIBUTING.md`.
Hooks live in `.claude/hooks/` and are wired in `.claude/settings.json`,
both of which are checked into the repo — so a fresh `git clone` plus
opening Claude Code in this checkout gives every developer the same
guardrails with no setup step.

The hook contract: before any tool invocation runs (Bash, Edit, Write,
…), the hook script reads a JSON payload from stdin and either allows
the call by exiting `0` or blocks it by exiting `2` and printing a
three-line diagnostic to stderr that Claude reads back. Blocking is
synchronous and absolute — there is no programmatic bypass, and no
in-band `CLAUDE_HOOKS_BYPASS` env var (because the agent could prepend
that itself).

## What each hook blocks

| Hook | Trigger | What it blocks | Source |
| ---- | ------- | -------------- | ------ |
| `block-destructive-bash.mjs` | every `Bash` call | `git clean -fd[x]`; `rm -rf` of `/`, `~`, `$HOME`, `.`; `git push --force` to `main`/`master`; `git reset --hard` / `git checkout .` / `git restore .` while the tree is dirty; `git branch -D main\|master`; `chmod -R 777`; `curl\|wget … \| sh\|bash` | `CLAUDE.md:26` (the `git clean -fd` incident); destructive-bash conventions |
| `block-claude-attribution.mjs` | `git commit *` or `gh pr *` | Commit messages and PR bodies containing `Co-Authored-By: Claude` (case-insensitive), `Generated with Claude Code`, or `🤖 Generated`. Scans `-m`, `--body`, heredocs, and the whole command string | `CLAUDE.md:175-176` |
| `block-prisma-db-push.mjs` | `*prisma db push*` | Any `prisma db push` invocation (via `npx`, `pnpm`, `yarn dlx`, or `bash -c`) — schema changes must go through `prisma migrate dev` | `CONTRIBUTING.md:69` |
| `block-destructive-sql.mjs` | `psql *` | `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, and `DELETE FROM` / `UPDATE … SET` without a `WHERE` clause inside a `-c "<SQL>"` payload — always-on regardless of host (yes, including local Docker postgres; a typo against local is still an evening of re-seeding) | `CLAUDE.md` (database safety) |
| `block-shared-env-sql-writes.mjs` | `psql *` | Any non-`SELECT`/`WITH`/`EXPLAIN`/`SHOW` / `\…` statement when the `psql` invocation targets a host containing `neon.tech`, `staging`, `prod`, or `production`. Local connections (`localhost`, `127.0.0.1`, `host.docker.internal`, no host) are not gated | `CLAUDE.md` (database safety) |
| `block-secret-paths.mjs` | `Edit`/`Write`/`MultiEdit`/`NotebookEdit` | Edits to `.env` / `.env.*` (except `.example`/`.sample`/`.template`), `**/*.pem` / `**/*.key`, `.npmrc`, or any basename starting with `credentials` (case-insensitive). **`.md` files are exempt** — docs about credentials are not credentials. `Read` is never blocked | conventions: environment variables / secrets |
| `enforce-branch-naming.mjs` | `git push*` | `git push` from a branch whose name does not match `^(feature\|fix\|docs\|refactor)/[a-z0-9._-]+$`. Explicit allow-list: `main`, `master`, detached HEAD, `--tags`, and pushes whose positional ref is a semver tag (`v1.2.3`, `v0.0.0-rc.1`) — those are tag pushes, not branch pushes. Does **not** run `lint`/`type-check`: `git push` stays fast | `CONTRIBUTING.md:50-57` |
| `pr-quality-gate.mjs` | `gh pr create*`, `gh pr edit*--body*`, `gh pr edit*--body-file*` | `gh pr create` and `gh pr edit` calls that mutate the PR body. Runs `pnpm type-check:changed`, `pnpm lint`, and `pnpm format:check` from the git worktree the PR command runs in — a leading `cd <dir>`, else the session cwd, falling back to `$CLAUDE_PROJECT_DIR` — sequentially with fail-fast. On the first non-zero exit it does **not** hard-block — it returns `permissionDecision: "ask"`, escalating to a user confirmation prompt that shows the last 20 lines of the failing check. **You** decide: fix it first, or approve and create the PR anyway. Allows `gh pr view`/`list`/`checkout`/`merge`/`review`/`comment` and `gh pr edit` calls without `--body`/`--body-file` (label/title/reviewer changes). **Slow by design** — see "PR-quality-gate latency" below | `CONTRIBUTING.md:79-86` |

### PR-quality-gate latency

`pr-quality-gate.mjs` runs three monorepo-wide checks before letting
`gh pr create` (or a PR-body edit) through. On a warm Turbo cache the
trio finishes in ~10-30 s; on a cold cache it can reach 1-2 minutes.
The agent's tool call waits for that run regardless of the outcome.
If a check fails the gate does **not** block — it surfaces the findings
and asks you whether to fix first or create the PR anyway. The cost
buys you that informed decision before the PR exists rather than a
surprise red check after. If even the wait is intolerable, the
documented escape paths still apply (run `gh pr create` yourself, or
session-disable hooks).

> **Note:** the "ask" escalation needs an interactive Claude Code
> session to prompt you. In headless/non-interactive runs there is no
> human to confirm; treat the gate as advisory there and run the checks
> in CI or manually.

## When you hit a block

> `pr-quality-gate.mjs` is the one exception: instead of hard-blocking it
> asks you to confirm (see above). Everything below applies to the other
> hooks, which hard-block.

The block message Claude shows you is always three lines:

```
Blocked: '<the literal command Claude tried to run>'
Reason: <one-line reason> (<source ref, e.g. CLAUDE.md:26>)
To proceed: <how to get past the block>
```

Read the reason. If the hook is correct, rephrase what you asked Claude
to do — usually that means a safer command (`pnpm clean` instead of
`git clean -fd`; `rm -rf node_modules` instead of `rm -rf .`; an explicit
`WHERE` clause on the SQL). If the hook is wrong, see "Escape paths"
below — and please send a PR to fix the pattern so the next person doesn't
hit it.

## Escape paths

There are exactly two:

1. **Run the command yourself in your own terminal.** Hooks fire only
   inside Claude Code's tool layer. Anything you run interactively in
   your own shell is unaffected — this is intentional. The point of
   the hook is to stop Claude from running the dangerous thing
   accidentally, not to stop you from running it on purpose.

2. **Temporarily disable hooks for the session.** Add `"disableAllHooks":
   true` to your `.claude/settings.local.json` (which is gitignored —
   personal per developer), do the one thing you need, then revert.
   **Don't commit the disable.** If a hook is genuinely wrong, raise a
   PR to fix the hook instead of normalizing the disable.

There is **no in-band bypass** (no `CLAUDE_HOOKS_BYPASS=…` env var, no
sentinel comment in the command). A programmatic bypass would defeat
the guard because the agent itself could prepend it. Friction is the
feature.

## Social contract

Session-only `disableAllHooks` is fine. Committing it isn't. If a hook
is wrong, fix the hook in a PR — don't work around it permanently. We
trust each other; the goal is to prevent accidental damage, not to lock
developers out of their own machines.

## Debugging a hook

- **Inspect the wiring**: run `/hooks` inside Claude Code to see the
  active hook list for this session.
- **Reproduce a block by hand**: pipe a JSON payload into the script
  directly:
  ```bash
  echo '{"session_id":"x","tool_name":"Bash","tool_input":{"command":"git clean -fd"}}' \
    | node .claude/hooks/block-destructive-bash.mjs
  echo "exit: $?"
  ```
  Exit `2` and a three-line stderr means the hook is working. Exit
  `0` means it allowed the call.
- **Test the full matrix**: `node --test ".claude/hooks/__tests__/*.test.mjs"`
  runs every fixture for every hook (~190 tests; ~2 seconds — the
  pr-quality-gate suite spawns a shell stub per case).
- **Log live invocations**: launch Claude with `claude --debug` or use
  the `--debug-file` flag — hook invocations appear in the log.

### Testing git-dependent hooks

`block-destructive-bash` consults `git status --porcelain` and
`git rev-parse --abbrev-ref HEAD` to gate a few patterns. The shared
git-helpers module honors two test seams so tests never need to mutate
the real repo:

- `FABRIC_TEST_BRANCH=feature/foo` — overrides `currentBranch()`.
  Use the literal `__DETACHED__` to simulate detached HEAD.
- `FABRIC_TEST_IS_DIRTY=1` (or `0`) — overrides `isDirty()`.

Tests pass these via the `env` option of `child_process.spawn` (see
`__tests__/_helpers.mjs`).

## Proposing a new hook

1. Open a PR adding `.claude/hooks/<name>.mjs` and a sibling
   `__tests__/<name>.test.mjs`.
2. Cover at least one "should block" and one "should allow" fixture
   per documented pattern. The spec doubles as the test plan.
3. Wire the hook in `.claude/settings.json` with a tight `if`
   pre-filter so it only spawns for relevant tool calls.
4. Update the table in this README and cite the rule it enforces
   (`CLAUDE.md` line, `CONTRIBUTING.md` line, or a `fabric/standards/`
   file).
5. The CI workflow `.github/workflows/claude-hooks.yml` will validate
   the JSON, syntax-check every `.mjs`, and run the test suite on the PR.

## Limitations

Be honest about what these hooks can and can't catch:

- **Hooks only fire inside Claude Code, not in plain shells.** A
  developer running `git clean -fd` in their own terminal is unaffected
  by design.
- **`psql -f file.sql` is not inspected.** Reading arbitrary disk
  paths from a hook is out of scope; if the file is destructive, the
  hook won't know.
- **Obscure encodings are out of scope.** The pattern matchers run on
  the literal command string, which catches `bash -c "git clean -fd"`
  but not (say) base64-then-eval. Gaps get tightened as they're found.
- **Tokenizer is global-quote-stripping.** A command-line that contains
  a quoted forbidden pattern as content — e.g.
  `git commit -m "rewriting old git push --force main script"` — will
  trip the destructive-bash hook. That's the same shell-wrapper detection
  that makes `bash -c "git clean -fd"` get blocked; we accept the
  occasional cosmetic false-positive in commit messages because the
  alternative is shell-parser-grade tokenization (out of scope).
- **Bare `git push --force` from a checkout of `main`/`master`.** The
  current force-push check only catches commands with an explicit
  positional `main`/`master` target. A future PR will tighten this by
  also consulting `currentBranch()` when `--force` is present without a
  positional ref.
- **The shared-env classifier is a substring check.** Hosts containing
  `neon.tech`, `staging`, `prod`, or `production` are shared; everything
  else (including random remote hosts) is treated as local. A new
  shared environment with a name that doesn't match those substrings
  will need the list extended.
- **Branch-naming hook trusts the local checkout.** `currentBranch()`
  comes from `git rev-parse --abbrev-ref HEAD` in the dev's working
  tree. A `git push` invoked from inside `git worktree add` or with
  `GIT_DIR=` env overrides may report a different branch than the one
  actually being pushed. Treat the gate as a "common-case" guardrail,
  not a hard contract.
- **PR-quality-gate has no timeout and no parallelism.** The three
  checks run sequentially via `execFileSync`; a hung Biome or `tsc`
  will hang the gate. Acceptable for a local pre-PR check; we'd
  reconsider if it ever becomes a recurring foot-gun.
- **No PostToolUse hooks.** Phase 1 + Phase 2 are blocking-only;
  notifications, logging, and transformations are explicitly out of
  scope for v1.

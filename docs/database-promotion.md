# Database promotion: expand/contract, preflight, forward-fix

How a schema change reaches production safely, and what to do when one goes wrong.

## Why this exists

A rolling deploy runs the old and the new application version against the **same
database** for the length of the rollout. Every schema change therefore has to be
correct for both versions at once. A change that is only correct for the new
version breaks the old one for as long as it is still serving — which, during a
rollout, is right now.

Two lock hazards matter as much as the compatibility rules, because both have
shipped here before:

- A non-`CONCURRENT` index build on a populated table holds a write lock for the
  whole build.
- An unbatched `UPDATE` backfill inside the migration transaction holds row locks
  across the table until the migration commits.

Either one, running while revisions rotate onto new code, turns a routine deploy
into an outage.

## The promotion sequence

Enforced by `.github/workflows/deploy-azure-container-apps.yml`:

1. **Preflight** — `pnpm --filter @repo/database preflight`
2. **Expand migrations** — `prisma migrate deploy`
3. **RLS** — `deploy:rls`
4. **Application rollout** — `deploy-infrastructure`, gated on step 2 succeeding
5. **Seeds** — `database-seed`, after the rollout
6. **Contract migrations** — a *later* release, never this one

Steps 1–3 run in the `database-migrate` job as a single `pnpm --filter
@repo/database promote`, which chains them with `&&`. `deploy-infrastructure`
lists that job in `needs:` and refuses to start unless it succeeded or was
skipped, so **a failed migration stops the promotion** instead of letting new code
reach traffic against an unmigrated schema.

`promote` is also the migration-runner image's entrypoint, so the sequence has one
definition rather than one in YAML and a second in a Dockerfile that nothing
exercises.

`database-migrate` still starts as soon as change detection finishes, so it
overlaps the container builds and is rarely the critical path. What changed
relative to the previous design is not when it starts — it is that the rollout
now waits for its result.

### Preflight

`packages/database/scripts/preflight-migrate.ts` fails closed on:

- **Session timeouts** — sets `lock_timeout` (5s) and `statement_timeout` (15m)
  **on the preflight's own connection, and on nothing else**. They bound the
  probes preflight itself runs. `promote` is
  `pnpm preflight && prisma migrate deploy && pnpm deploy:rls` — three separate
  processes with three separate connections — and a session GUC dies with the
  connection that set it (`preflight-migrate.ts` opens its own `new Client` and
  `end()`s it in a `finally`). **`prisma migrate deploy` therefore inherits
  neither timeout and runs at the server defaults.** A migration that needs a
  bound must set its own `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout`
  as the FIRST statement of its file, before any `ALTER` has taken a lock;
  `20260815120400` and `20260820120000` are the worked examples. This paragraph
  previously read as though the preflight timeouts protected the migrations'
  `ALTER`s, which the process boundary has never allowed.
- **A migration left mid-flight** — a `_prisma_migrations` row that started and
  was neither finished nor resolved means a previous promotion died part way.
  Migrating on top of that produces divergence no rollback untangles. A row
  explicitly resolved as rolled back (`prisma migrate resolve --rolled-back`) is
  the healthy end state, not a fault — the dev database carries two, and treating
  them as failures blocked every deploy until that was corrected.
- **A migration already running** — advisory-lock probe.
- **Long-running transactions** — DDL would queue behind them, and everything else
  would queue behind the DDL.

Mutual exclusion comes from the job's `concurrency` group and the advisory lock
`prisma migrate deploy` takes for itself. The preflight probe is a fast, readable
diagnostic, not the guard.

## Expand and contract

**Expand** changes are additive and safe for the previous app version. They ship
in the same release as the code that uses them.

- Add a nullable column, or one with a `DEFAULT`
- Add a table
- Add an index — `CONCURRENTLY`, on a populated table
- Widen a type
- Add a `CHECK ... NOT VALID`, then `VALIDATE CONSTRAINT` separately

**Contract** changes remove or tighten. They are only safe once no running version
depends on the old shape, which means **a later release** — never the one that
introduced the replacement.

- Drop a column or table
- Drop an index — `CONCURRENTLY`, and only once nothing depends on the guarantee it enforced
- `SET NOT NULL`
- Rename
- Narrow a type
- Tighten a constraint or an RLS policy the old code cannot satisfy

The rule that does the work: **the previous app version must run correctly against
the new schema.** If it cannot, the change is contract-phase and belongs in a
later release.

### The four-step shape

Replacing a column, in full:

| Release | Migration | Application |
|---|---|---|
| N | Add `newCol` nullable | Write both, read `oldCol` |
| N | — | (backfill job runs out of band, batched) |
| N+1 | — | Read `newCol`, still write both |
| N+2 | Drop `oldCol` | Write only `newCol` |

Nothing here is optional. Collapsing it into one release is how a rename takes
production down.

### Backfills

**Backfills do not belong in migrations.** A migration is one transaction; a
whole-table `UPDATE` inside it holds locks for its duration and cannot be resumed
if it fails halfway. Add the column in the migration, then backfill from a
batched, resumable job that commits in chunks and can be re-run.

### Enforcement

`pnpm --filter @repo/database lint:migrations`, wired into CI as
`.github/workflows/migration-safety.yml`, rejects: `blocking-index`,
`unbatched-backfill`, `not-null-without-default`, `bare-set-not-null`,
`rename-in-place`, `type-change`, `unvalidated-constraint`,
`destructive-without-marker`.

`blocking-index` covers both directions: a `CREATE INDEX` and a `DROP INDEX` on a
populated table each take a lock for the whole operation, and `CONCURRENTLY` is the
answer to both. A drop additionally always reports `destructive-without-marker` —
`CONCURRENTLY` answers the lock, not the question of whether anything still depends
on the index.

`unvalidated-constraint` is the one most likely to be new to you. `ADD CONSTRAINT
... FOREIGN KEY` and `... CHECK` validate against every existing row while holding
a lock. Add them `NOT VALID` first, then `VALIDATE CONSTRAINT` in a separate
migration — that second step takes a weaker lock and can run while traffic
continues. `PRIMARY KEY` and `UNIQUE` also build an index and do not accept `NOT
VALID`, so on a populated table they are contract-phase work. None of this applies
to a table the same migration creates, which is the shape Prisma generates for a
new model and stays clean.

The linter derives table age from migration history — a table created in the same
migration is empty, so indexing or backfilling it is free and stays clean.

Migrations that predate the linter are grandfathered in
`packages/database/migration-lint-baseline.json`. That list only shrinks; CI fails
a PR that grows it.

### The gate is blocking

`Lint migrations` is required to merge, through a **separate ruleset
(`migration-lint`)** rather than through `protect-master`. A pull request whose
new migration trips a rule cannot be merged until the migration changes or a
reviewed marker explains why the finding is safe.

It was staged on Evaluate first, and that staging was deliberate. Rulesets,
unlike classic branch protection, let you require a check that has never run —
and a required check that never reports leaves a pull request stuck on
*"Expected — Waiting for status to be reported"* forever. Adding this straight
to `protect-master` did exactly that to eight open pull requests, because they
predated the workflow and so had never run it.

The fix for that was to stop path-filtering `migration-safety.yml`, so the job
runs on every pull request and reports either way, scoping itself internally
instead. Once that landed, the "cycle every open PR through a push first" step
stopped being necessary — the check reports on any pull request that has been
pushed since.

**Three things the ruleset needs, beyond `enforcement=active`.** Each was found
by inspecting the repository rather than by reasoning about it, and the first
would have stopped releases:

- **A bypass actor.** `protect-master` grants the Maintainer role `always`
  bypass; this ruleset was created with none, so `current_user_can_bypass` read
  `never` even for an admin. That matters because the Changesets version pull
  request (`changeset-release/master`) is pushed with `GITHUB_TOKEN`, and GitHub
  deliberately fires no workflows for such pushes — its head commit carries no
  Actions check runs at all, only the Vercel comment bot. It merges today purely
  on the `protect-master` bypass. Requiring `Lint migrations` without the same
  bypass would have made every future release pull request permanently
  unmergeable. The ruleset now carries the identical Maintainer bypass, which
  grants no privilege that `protect-master` did not already grant.
- **A literal ref scope.** It targeted `~DEFAULT_BRANCH`, which is harmless while
  a rule only evaluates. `protect-master` was rescoped to the literal
  `refs/heads/master` precisely so its rules would not follow the default branch
  if that moves; this ruleset now matches, so it cannot impose a required status
  check on a branch that takes direct pushes.
- **A name that is still true.** It was `migration-lint-evaluate`. A ruleset
  named for a mode it is no longer in is a trap for whoever reads it next.

Before flipping enforcement, confirm every open pull request has a
`Lint migrations` run on its head commit:

```bash
for pr in $(gh pr list --state open --base master --json number --jq '.[].number'); do
  sha=$(gh pr view "$pr" --json headRefOid --jq '.headRefOid')
  echo "$pr $(gh api "repos/<owner>/<repo>/commits/$sha/check-runs" \
    --jq '[.check_runs[] | select(.name=="Lint migrations")] | if length==0 then "MISSING" else .[0].conclusion end')"
done
```

A `MISSING` only matters if that pull request is otherwise mergeable. When the
gate went active, two lacked the check and neither was affected: the version pull
request cannot receive it at all and merges on bypass, and the other was already
missing three other required checks its head predated. Compare each one against
the required set before concluding it is newly stranded.

Rolling back is one call — `--field enforcement=evaluate` — and does not require
restoring the rest of the ruleset.

When a finding is genuinely safe, say why in the migration:

```sql
-- migration-lint: allow destructive-without-marker — expand shipped two releases ago,
-- no running version reads this column
ALTER TABLE "example" DROP COLUMN "legacyField";
```

The reason is mandatory — a marker without one does not suppress anything. It is
there so a reviewer can check the claim, not so the gate can be silenced.

### `CONCURRENTLY` with Prisma

Prisma wraps a **multi**-statement migration in a transaction and does **not** wrap
a single-statement one, and `CONCURRENTLY` cannot run inside a transaction. So a
migration containing *only* a `CREATE INDEX CONCURRENTLY` or `DROP INDEX
CONCURRENTLY` applies through the ordinary `migrate deploy` path with no special
handling and no human step. Add a second statement — even `SET LOCAL
lock_timeout` — and it fails with SQLSTATE 25001.

That is the whole mechanism; there is no per-file transaction opt-out to reach
for. See *Forward-fix → "The exception, stated precisely"* below for the measured
detail and for the two migration headers that still contradict it.

## Forward-fix

**Schema rollback is not a recovery plan.** A dropped column cannot be un-dropped
with its data. Reverting a schema breaks the new app version that is already
serving. And the rollback itself destroys the evidence of what happened.

The recovery path is always forward.

### When a migration fails

The promotion has already stopped — `deploy-infrastructure` never ran, and the
previous app version is still serving against the pre-migration schema.

**Order matters. Fix the file before you resolve the ledger.** `migrate deploy`
re-runs any migration that is not recorded as applied, so resolving first just
makes the next attempt fail on the same SQL and write a *fresh* mid-flight row.
Rehearsal put four rows in the ledger for one migration before this was obvious.

1. **Read the failure.** The `migrate deploy` output names the migration, the
   failing statement and the Postgres error code (`P3018` wrapping e.g. `42P01`).
2. **Fix the migration file.** Correct the SQL, or delete the migration directory
   if the change should not ship at all.
   *The exception the old wording generalised from:* if the migration already
   applied cleanly in another environment, do **not** edit it — Prisma stores a
   checksum and the edit will be rejected there. Ship a new corrective migration
   instead. That case does not apply when the migration has never succeeded
   anywhere, which is the usual one, because promotion stops at the first
   environment it breaks.
3. **Resolve the ledger.** `prisma migrate resolve --rolled-back "<name>"` — once
   per failed attempt. `prisma migrate status` lists what needs it.
4. **Re-run the promotion.** Preflight will refuse until step 3 is done.

Measured in rehearsal: **10 seconds** from resolve to a green promotion, on a
database with 396 migrations. The cost is deciding what to do, not doing it.

**A failed migration leaves no partial schema.** Prisma runs each migration in a
transaction, so a statement failing halfway rolls the whole file back — verified
in rehearsal, where the successful first `ALTER TABLE` of a two-statement
migration left no column behind.

**The exception, stated precisely, because the imprecise version has caused real
confusion:** Prisma wraps a **multi**-statement migration in a transaction and
does **not** wrap a single-statement one. `CREATE INDEX CONCURRENTLY` cannot run
inside a transaction, so a migration containing *only* that statement applies
through the ordinary `migrate deploy` path with no special handling and no human
step — verified on PostgreSQL 16 with Prisma 6.18. Add a second statement to the
same file and it fails with SQLSTATE 25001. This is why the expand/contract rules
say to put a concurrent index build in a migration of its own: the rule is load-
bearing, not stylistic.

**Two migration files still carry a comment that contradicts this — believe this
page, not them.** `20260511151927_notification_dedup_create_live_index` and
`20260511151928_notification_dedup_drop_legacy_index` are each headed
"CONCURRENTLY DDL REQUIRES MANUAL APPLICATION" and instruct an operator to run the
SQL through psql and then `prisma migrate resolve --applied`. That was never
necessary: both are single-statement files and `migrate deploy` has been applying
them automatically since they landed. The notes cannot simply be corrected in
place, because **editing an already-applied migration changes its checksum and
Prisma rejects it in every environment that already ran it** — the same rule stated
in step 2 above. So the fix lives here instead.

A concurrent build that *does* fail leaves the index behind with
`indisvalid = false`, and — the trap — a re-run of `CREATE INDEX CONCURRENTLY IF
NOT EXISTS` sees the name is taken and silently skips it, so the invalid index
persists and serves no queries. Check with
`SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` and `DROP INDEX`
before retrying.

### When a migration succeeded but the rollout is wrong

The schema is ahead of the code, which is the safe direction — expand migrations
are backward-compatible by construction, so the previous app version runs
correctly against them.

1. **Roll the application back.** Container revisions, not the schema.
2. **Leave the schema alone.** It is compatible with the version you just rolled
   back to.
3. **Fix the code, ship again.**

### When a contract migration was premature

The worst case: something was dropped that a running version still needs.

1. **Roll the application forward, not back** — to the version that does not need
   the dropped object, if one exists.
2. If it does not, **restore the data** from a Neon branch taken before the
   migration (see below) and re-add the object in a new migration. This is a data
   recovery, not a schema rollback, and it is slow — which is the argument for the
   expand/contract discipline that prevents it.

### Rehearsal

A runbook nobody has executed is a document, not a procedure.

**Rehearsed 2026-07-30** against a throwaway Postgres 16 loaded with all 396
migrations — not staging, so nothing shared was put at risk. A two-statement
migration whose second statement referenced a missing table was applied, and the
documented steps were then followed literally.

What it found, all now folded in above:

- **The step order was wrong.** The page said to resolve the ledger and write a
  corrective migration without touching the failed file. Following that literally
  loops: `migrate deploy` retries the broken file, fails again, and writes another
  mid-flight row. The file has to be fixed first.
- **"Never edit the failed migration" was over-general.** It holds only once a
  migration has applied somewhere, because of Prisma's checksum. In the ordinary
  case — promotion stops at the first environment it breaks — editing is correct.
- **A failed migration leaves no partial schema**, except where the migration
  cannot run in a transaction.
- **Recovery takes about ten seconds** once the decision is made.

Re-rehearse when the promotion sequence changes. To reproduce: run a Postgres
container, point `DATABASE_URL` and `DIRECT_URL` at it, `prisma migrate deploy`,
then add a migration that fails on its second statement.

### When an ordinary index build leaves the migration unresolved

The common case, and the one the manual `indisvalid` SQL below does *not* cover.

An ordinary `CREATE INDEX` runs inside Prisma's transaction, so the DDL is
all-or-nothing and no invalid index is ever left behind. Prisma's own bookkeeping
is not inside that transaction: `_prisma_migrations` is stamped `finished_at`
*after* the commit. A process killed in that window leaves the migration
unresolved in the ledger while the schema may or may not already carry its
objects.

**Read the catalog before you choose a resolve command.** Two of the reachable
states take opposite commands and a third takes neither, so there is no safe
default to reach for. Name the indexes exactly — a `LIKE` over the table's
indexes also returns unrelated ones that predate the migration, and a diagnostic
that reports those miscounts the states below:

```sql
SELECT c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid)
  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
 WHERE c.relname IN ('<first index the migration creates>',
                     '<second index the migration creates>');
```

| What the catalog shows | What happened | What to run |
|---|---|---|
| **Neither** index exists | The statement failed and the transaction rolled back | `prisma migrate resolve --rolled-back "<migration>"`, then re-run the promotion |
| **Both** exist, **both** `indisvalid = true`, and **both** definitions match the migration file exactly | The commit succeeded and the process died before the ledger write | `prisma migrate resolve --applied "<migration>"` |
| **Exactly one** exists — or both exist but either is invalid or differently shaped | A name was already taken (the collision a build with no `IF NOT EXISTS` fails on by design), or someone hand-applied part of the file | **No default answer.** Compare `pg_get_indexdef` against the migration file. Not the file's definition → drop it, `--rolled-back`, re-run. Is the file's definition → finish the remaining objects by hand to match the file exactly, then `--applied` |

"Both names present" is not enough for row 2. If either index is invalid or its
definition differs, these are not the migration's indexes: the first `CREATE`
failed against a pre-existing name and the rollback left someone else's objects
standing. Treat that as row 3.

Guessing `--rolled-back` on the both-exist case is **recoverable, not data loss**.
The re-run fails on `relation already exists`, because a migration that
deliberately omits `IF NOT EXISTS` is not re-runnable over its own output. That
failure is loud and costs one command to correct.

### When a concurrent index build fails

Rehearsed 2026-07-30, against 5,000 rows carrying a duplicate.

This is the one shape that leaves something behind, and it does not clean up
after itself:

1. `CREATE UNIQUE INDEX CONCURRENTLY` fails on the duplicate, as expected.
2. It leaves an index with `indisvalid = false` and `indisready = false`. The
   planner ignores it, so queries are unaffected.
3. **Re-running the same statement fails with `relation already exists`.** The
   migration is not re-runnable, which is the part that surprises people.

Recover by dropping the invalid index, fixing the data, then rebuilding:

```sql
DROP INDEX CONCURRENTLY widget_sku_key;
-- correct the duplicates
CREATE UNIQUE INDEX CONCURRENTLY widget_sku_key ON widget(sku);
```

Took about a second at that size, and the rebuilt index came back
`indisvalid = true`.

**Neither statement can run inside a transaction.** `CREATE INDEX CONCURRENTLY`
and `DROP INDEX CONCURRENTLY` both fail with *"cannot run inside a transaction
block"*, so the recovery carries the same constraint as the thing that failed:
run it from a psql session, or from a migration using the documented transaction
opt-out. Find invalid indexes with:

```sql
SELECT c.relname FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
 WHERE NOT i.indisvalid;
```

## Backups

Staging and production both run on **Neon** (`packages/database/prisma/client.ts`).
Neon branches are copy-on-write and effectively instant, which makes them a far
better pre-migration restore point than a snapshot:

`capture:restore-point` runs immediately before preflight and names what it
captures `pre-migration-<sha>-<timestamp>`, reporting it in the job summary.

Two providers, because the database is moving off Neon:

| Provider | What it does | Configure with |
|---|---|---|
| `neon` | Creates a copy-on-write branch. Effectively instant, so it is cheap enough to take on every promotion rather than only before destructive changes. Recover by reading from the branch | `NEON_API_KEY` + `NEON_PROJECT_ID` |
| `pg_dump` | Writes a custom-format logical dump. Works against any Postgres, and is what remains once Neon is gone. Costs time and disk in proportion to the database. Recover with `pg_restore` | `RESTORE_POINT_DIR` (+ `DATABASE_URL` or `DIRECT_URL`) |

Whichever set of credentials is present decides the provider. Set
`RESTORE_POINT_PROVIDER` to force one. When a provider is named explicitly and
its credentials are absent, the step reports what is missing rather than falling
back — a promotion that asked for a branch and quietly got a dump would leave
someone hunting for a branch that was never created.

**`pg_dump` must be at least the server's major version.** It refuses to dump a
newer server outright. Enabling it on dev failed on exactly this:

```
pg_dump: error: aborting because of server version mismatch
pg_dump: detail: server version: 17.10; pg_dump version: 16.14
```

GitHub's `ubuntu-latest` ships client 16, and the database is on 17, so the step
needs a matching client installed before it runs.

**Installing the package is necessary and not sufficient.** The runner image puts
`/usr/lib/postgresql/16/bin` on `PATH` ahead of `/usr/bin`. Installing
`postgresql-client-17` *does* update `/usr/bin/pg_dump` — `postgresql-common`'s
wrapper follows the newest installed version — but `PATH` never reaches
`/usr/bin`, because the versioned 16 directory shadows it. So the install
succeeds and `pg_dump` stays on 16.

A dev run on 2026-08-19 installed `17.11` and `pg_dump --version` still printed
`16.14`, so the capture failed on the exact mismatch the step exists to prevent.
Because that version line was informational, the step exited 0 while printing the
proof of its own failure.

Reproduced on `ubuntu:24.04`, which is worth knowing because it means you never
need a deploy to test this:

| PATH state | after installing 17 |
|---|---|
| only `/usr/bin` | `17.11` — no bug |
| `/usr/lib/postgresql/16/bin` first (the runner) | `16.15` — the bug |
| `/usr/lib/postgresql/17/bin` first (the fix) | `17.11` |

So the step also puts the versioned directory ahead of `/usr/bin` for the steps
that follow, and asserts the major version it resolved:

```yaml
- name: Install a matching postgresql-client
  env:
    PG_MAJOR: '17'
  run: |
    set -euo pipefail
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | sudo gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
    echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      | sudo tee /etc/apt/sources.list.d/pgdg.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq "postgresql-client-${PG_MAJOR}"

    BIN_DIR="/usr/lib/postgresql/${PG_MAJOR}/bin"
    echo "$BIN_DIR" >> "$GITHUB_PATH"

    # $GITHUB_PATH only applies to later steps, so assert on the binary directly.
    RESOLVED=$("$BIN_DIR/pg_dump" --version)
    case "$RESOLVED" in
      "pg_dump (PostgreSQL) ${PG_MAJOR}."*) ;;
      *) echo "::error::Expected pg_dump ${PG_MAJOR}.x, got: $RESOLVED"; exit 1 ;;
    esac
```

The general shape is worth keeping: a setup step that ends in a bare `--version`
echo proves nothing. Compare it to what you expected and fail on a mismatch, or
the step reports success for having run rather than for having worked.

The Neon provider has no such constraint, since the branch is created through the
API rather than by a local client.

**Opt-in, and best-effort.** With no provider configured the step says so and
exits 0. With one configured, a capture that fails emits a warning and the
promotion continues. `--require` is what turns both cases into a hard gate — a
missing restore point should not stop a deploy unless someone decided it should.

#### Turning it on

**Use `pg_dump`.** The `neon` provider stops existing the moment the database is
not on Neon, and it is already on its way off. `pg_dump` needed work to survive
row-level security, described below, and now does.

The failure found on a dev promotion 2026-08-19:

```
pg_dump: error: query failed: ERROR:  query would be affected by
         row-level security policy for table "agent"
```

Postgres refuses because the dump would be **filtered**, and a filtered dump is
a corrupt backup. Two things make that awkward here:

- **A permissive policy is not a substitute for `BYPASSRLS`.** Measured on
  Postgres 17: a role with a `USING (true)` policy over a `FORCE ROW LEVEL
  SECURITY` table fails with the identical message.
- **This managed host grants `BYPASSRLS` to nobody.** `apply-rls-direct.ts`
  records it: the app role cannot `CREATE`/`ALTER ROLE`, and no one holds the
  superuser needed to set the attribute. That is why `fabric_app` and
  `fabric_worker` reach rows through permissive policies instead.

`--enable-row-security` lifts the refusal, and **on its own it is a data-loss
bug**: it dumps only the rows the role can see. Measured the same day — a
two-row table, a role limited by policy to one of them, `pg_dump` **exiting 0**,
and **one row** in the dump. A restore point that reports success having dropped
half the database is worse than none, because the first person to find out is
whoever is attempting a recovery.

The flag is safe exactly when the role provably sees every row, so
`capture-restore-point.ts` establishes that before using it. It queries
`pg_policies` for every RLS-enabled table and refuses when a **restrictive**
policy applies — those AND-combine and can filter whatever the permissive ones
allow — or when no **permissive** policy grants unconditional visibility
(`USING (true)`, or no `USING` at all). Only on an empty result does it pass the
flag, and only for a role that does not already bypass RLS; a bypassing role
dumps exactly as before. Anything the query cannot account for stays unprovable,
so the failure mode is a refused capture rather than a quiet one.

That is what makes capture work on this host: the `USING (true)` policies
`APP_RLS_BYPASS` and `worker_bypass` create satisfy the check, so the dump is
complete *and* provably so, rather than complete by assumption.

Enabling it is a settings change, not a code change, and it splits into two
steps that should not be taken together:

1. **Prove the mechanism.** Point it at a directory on the runner:

   ```bash
   gh variable set RESTORE_POINT_DIR --env dev --body '/tmp/restore-points'
   ```

   The next deploy's *Capture restore point* step reports the provider it chose
   and the size of the dump it wrote. That is enough to know `pg_dump` runs, that
   the matching client install worked, and that the connection string reaches the
   database. The runner is discarded when the job ends, so nothing is retained
   and no decision about stored data has been made yet.

   **Do not wait on a deploy to test the dump itself.** Deploys to an environment
   serialize, so a stuck one blocks everyone else's, and the whole `pg_dump` path
   runs against the local stack in a couple of minutes. The local Postgres is the
   same major version the deployed one is, so a client container reproduces the
   real pairing:

   ```bash
   docker run --rm --network "container:<postgres-container>" \
     -e PGHOST=localhost -e PGPORT=5432 -e PGUSER=... -e PGPASSWORD=... -e PGDATABASE=... \
     -v "$PWD/out:/out" ubuntu:24.04 bash -c '
       apt-get update -qq && apt-get install -y -qq curl gnupg lsb-release >/dev/null
       curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
       echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
       apt-get update -qq && apt-get install -y -qq postgresql-client-17 >/dev/null
       export PATH="/usr/lib/postgresql/17/bin:$PATH"
       pg_dump --format=custom --file /out/proof.dump
       pg_restore --list /out/proof.dump | head'
   ```

   That is the same invocation the script makes. Run on 2026-08-19 it produced a
   1.9 MiB custom-format dump from a 17.10 server with a 17.11 client, and
   `pg_restore --list` read it back. What it does *not* cover is the runner's own
   `PATH`, which is the one part that needs CI.

2. **Decide where a dump lives.** A dump on a discarded runner proves the
   mechanism and is *not* a restore point — nothing can be recovered from it.
   Persisting one means holding a full copy of the database at rest, which is a
   data-governance decision (retention window, encryption, who may read it), not
   an engineering one. Settle that before pointing `RESTORE_POINT_DIR` anywhere
   durable.

Only once a dump is genuinely persisted does `--require` make sense. Adding it
earlier would gate promotion on the presence of a file that is thrown away
minutes later.

Preflight still asserts only what it can prove about database state. It does not
assert that a restore point exists; `--require` is what makes that a gate.

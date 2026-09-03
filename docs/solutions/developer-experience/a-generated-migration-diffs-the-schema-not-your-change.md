---
title: "A generated migration is a diff of the schema, not a diff of your change"
date: 2026-09-03
category: developer-experience
module: database prisma migrations
problem_type: developer_experience
component: database
severity: high
applies_when:
  - "You are about to run `prisma migrate dev` in this repository"
  - "A generated migration contains statements you did not ask for"
  - "A migration fails to apply with a dependency error on an object your change never mentions"
  - "You are reviewing a PR whose migration touches tables the PR does not otherwise discuss"
tags: [prisma, migrations, schema-drift, ddl, destructive, review, database]
related_components: [database, migrations]
audience: Anyone adding a Prisma migration, and anyone reviewing one
owner: Fabric platform
---

# A generated migration is a diff of the schema, not a diff of your change

## Context

Adding one table to the schema (`retired_prompt_key`, two statements' worth) produced a migration with **24 statements**. Three were the ones asked for. The other twenty-one dropped foreign keys, indexes and column defaults across `publishing_topic`, `publishing_topic_draft`, `publishing_topic_working_draft`, `project_context`, `project_context_conversation_bundle`, `project_context_conversation_claim`, `project_qa_settings`, `qa_sign_off`, `pull_request_review` and `pull_request_review_finding` — tables the change never touched.

None of that was a bug in Prisma. `migrate dev` does exactly what it says: it diffs `schema.prisma` against the accumulated migration history and writes whatever closes the gap. When those two have already drifted apart — and in this repository, with 509 migrations, they had — **your migration inherits the drift**. The tool cannot tell your intent from someone else's leftovers, because it never sees your intent; it only sees two states of the world.

The drift was found by luck, not by review. Applying the migration failed:

```
ERROR: cannot drop index publishing_topic_id_project_key because constraint
publishing_topic_id_project_key on table publishing_topic requires it
```

Postgres refused one of the twenty-one statements (`2BP01`). Had that particular index not been protected by a constraint, every statement would have applied cleanly, the run would have reported success, and a migration dropping other teams' constraints would have gone into review looking normal.

## Guidance

**Read the generated migration statement by statement before you keep it.** Not the summary line, not the file name — the statements. Ask of each one: did my schema change ask for this?

**Keep only your statements.** Deleting the rest is not hand-writing a migration: the SQL Prisma produced for *your* change is still Prisma's, and it is still correct. What you are discarding is a diff of somebody else's unfinished business, which does not belong in your PR and is not yours to decide about.

**Then prove the trimmed file applies.** Point at a scratch database, apply the whole history plus your migration, and inspect the object you meant to create:

```bash
cd packages/database
U="postgresql://<user>:<password>@<host>:<port>/<scratch_db>"
DATABASE_URL="$U" DIRECT_URL="$U" npx prisma migrate deploy --schema=./prisma/schema.prisma
```

Both `DATABASE_URL` and `DIRECT_URL` must be set — the schema reads both, and setting only one fails validation rather than falling back.

**Do not resolve the drift as a side effect of your ticket.** Those twenty-one statements describe a real inconsistency somebody should fix deliberately, with its own review. Silently folding it into an unrelated PR means the reviewer who approves your feature is also approving the removal of constraints they were never told about.

## Why This Matters

The failure mode is not that the migration errors — an error is the good case, because it stops you. The failure mode is a **clean run**. Drift-derived statements are mostly `DROP`s, and dropping an index or a default usually succeeds. The migration then reports success, the diff looks plausible to a reviewer who has no reason to cross-check every table against the ticket, and the constraint is gone from production.

That is the same shape as the learning in `docs/solutions/design-patterns/a-surface-must-not-report-absence-it-did-not-verify.md`: a tool reporting success for work it did not verify is more dangerous than one that crashes, because success is believed and not investigated.

## When to Apply

Every `prisma migrate dev` in this repository, until schema and history are reconciled. The check costs a minute; the drift is already present, so this is not a hypothetical.

Two conditions make it more likely to bite:

- **The local database has diverged from the repo's history.** `prisma migrate status` will say so — it names migrations applied in the database that are absent locally, and vice versa. In that state `migrate dev` may also offer to **reset** the database, which destroys local data. Generating against a scratch database avoids the offer entirely.
- **You are pointing at the wrong database.** Aspire assigns the Postgres container a random host port, while `.env.local` names a fixed one. If another project holds that port, `migrate dev` connects to *their* database and the only thing standing between you and a migration applied to an unrelated project is whether the passwords happen to differ. Check `docker port <postgres-container>` before trusting `.env.local`.

## Examples

**What the generator produced** (24 statements, abridged):

```sql
-- Not asked for: twenty-one statements of accumulated drift
DROP INDEX "public"."publishing_topic_id_project_key";
DROP INDEX "public"."qa_sign_off_userStoryId_createdAt_idx";
ALTER TABLE "public"."publishing_topic_working_draft" DROP CONSTRAINT "publishing_topic_working_draft_topic_project_fkey";
ALTER TABLE "project_context" ALTER COLUMN "ownerKey" DROP DEFAULT;
-- ... seventeen more ...

-- Asked for: the actual change
CREATE TABLE "retired_prompt_key" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredBy" TEXT NOT NULL,
    CONSTRAINT "retired_prompt_key_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "retired_prompt_key_key_key" ON "retired_prompt_key"("key");
```

**What was kept:** the last two statements, nothing else — then verified by applying all 509 migrations plus this one to an empty database and confirming the table and both indexes existed.

**A quick way to see the shape of what you were handed**, before reading it in full:

```bash
grep -oE '^(CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX|DROP INDEX|ALTER TABLE|DROP TABLE)[^;]*' \
  prisma/migrations/<your_migration>/migration.sql | sed 's/(.*//' | sort | uniq -c | sort -rn
```

If that list is longer than your change, stop and read the file.

## Related

- `docs/solutions/design-patterns/a-surface-must-not-report-absence-it-did-not-verify.md` — the same failure shape: a successful-looking result nobody verified.
- `CLAUDE.md` § Database — the standing rule to use `migrate dev` and never `db push`. This learning does not weaken that rule; it says what to do with what `migrate dev` hands back.

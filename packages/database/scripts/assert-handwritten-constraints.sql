-- Hand-written constraints whose shape Prisma cannot express, asserted
-- against a database built from the migration chain.
--
-- schema.prisma declares each of these as an @ignore'd relation so that
-- `prisma migrate dev` keeps it, but Prisma compares neither MATCH FULL nor
-- an ON DELETE SET NULL column list. Editing one of those relation lines
-- makes `migrate dev` recreate the constraint without them, and Postgres
-- accepts that DDL silently: a lost column list only surfaces when a delete
-- tries to null a NOT NULL column. The drift check cannot see it either,
-- because the regenerated migration and the schema then agree.
--
-- Run by the `Migration drift` job in .github/workflows/unit-tests.yml.
-- Locally, against a database migrated with `prisma migrate deploy`:
--   npx prisma db execute --file ./scripts/assert-handwritten-constraints.sql --schema=./prisma/schema.prisma
DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ['project_context_conversation_bundle_owner_fkey', 'MATCH FULL'],
    ['project_context_conversation_claim_owner_fkey', 'MATCH FULL'],
    ['publishing_topic_working_draft_source_draft_fkey', 'ON DELETE SET NULL ("sourceDraftId")']
  ];
  definition text;
BEGIN
  FOR i IN 1 .. array_length(expected, 1) LOOP
    SELECT pg_get_constraintdef(oid) INTO definition
      FROM pg_constraint
     WHERE conname = expected[i][1];
    IF definition IS NULL THEN
      RAISE EXCEPTION 'constraint % is missing', expected[i][1];
    END IF;
    IF position(expected[i][2] IN definition) = 0 THEN
      RAISE EXCEPTION 'constraint % lost %: %', expected[i][1], expected[i][2], definition;
    END IF;
  END LOOP;
END $$;

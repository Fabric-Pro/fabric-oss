-- Hand-written constraints whose shape Prisma cannot express, asserted
-- against a database built from the migration chain.
--
-- schema.prisma documents each constraint because Prisma cannot represent all
-- of their shapes. For @ignore'd relations, `prisma migrate dev` keeps them but
-- compares neither MATCH FULL nor
-- an ON DELETE SET NULL column list. Editing one of those relation lines
-- makes `migrate dev` recreate the constraint without them, and Postgres
-- accepts that DDL silently: a lost column list only surfaces when a delete
-- tries to null a NOT NULL column. The drift check cannot see it either,
-- because the regenerated migration and the schema then agree.
--
-- Run by the `Migration drift` job in .github/workflows/unit-tests.yml.
-- Locally, against a database migrated with `prisma migrate deploy`:
--   npx prisma db execute --file ./scripts/assert-handwritten-constraints.sql
DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ['delivery_watch_identity', 'CHECK'],
    ['delivery_watch_checkpoint', 'CHECK'],
    ['delivery_watch_cursor_ciphertext', 'CHECK'],
    ['delivery_grant_bounds', 'CHECK'],
    ['delivery_observation_bounds', 'CHECK'],
    ['delivery_source_command_bounds', 'CHECK'],
    ['delivery_capture_page_bounds', 'CHECK'],
    ['project_context_conversation_bundle_owner_fkey', 'MATCH FULL'],
    ['project_context_conversation_claim_owner_fkey', 'MATCH FULL'],
    ['publishing_topic_working_draft_source_draft_fkey', 'ON DELETE SET NULL ("sourceDraftId")'],
    ['parlume_meeting_session_agent_selection', 'CHECK'],
    ['project_recipient_brand_display_font_catalog', 'CHECK'],
    ['project_recipient_brand_body_font_catalog', 'CHECK'],
    ['agent_test_run_report_bounds', 'agent_test_report_is_minimized'],
    ['run_quality_policy_target_xor', 'CHECK'],
    ['run_quality_assessment_source_xor', 'CHECK'],
    ['run_quality_assessment_state', 'CHECK'],
    ['run_quality_assessment_rules_bounded', 'CHECK'],
    ['run_quality_policy_revision_positive', 'CHECK'],
    ['run_quality_policy_rules_bounded', 'CHECK'],
    ['run_quality_assessment_revision_positive', 'CHECK'],
    ['run_quality_assessment_evidence_bounded', 'CHECK'],
 ['frame_change_proposal_state','CHECK'],
 ['frame_approved_revision_snapshot','CHECK']
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
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='frame_change_proposal_binding' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='frame_approved_revision_binding' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pin_legacy_frame_publication' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='keep_frame_proposal' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='keep_frame_approval' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'Frame reviewed revision protection is missing';
 END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('delivery_watch_identity','delivery_grant_identity','delivery_observation_immutable','delivery_command_immutable','delivery_page_immutable') AND NOT tgisinternal) <> 5 THEN
    RAISE EXCEPTION 'Private delivery source immutability protection is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid=to_regprocedure('public.agent_test_report_is_minimized(jsonb)')
      AND provolatile='i' AND prorettype='boolean'::regtype
      AND proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
      AND position('fabric-deterministic-v1' IN pg_get_functiondef(oid)) > 0
      AND position('exact-text' IN pg_get_functiondef(oid)) > 0
      AND position('allowed_result_keys' IN pg_get_functiondef(oid)) > 0
  ) THEN
    RAISE EXCEPTION 'agent test minimized report validator is missing or lost its versioned contract';
  END IF;
END $$;

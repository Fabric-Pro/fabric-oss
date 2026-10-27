-- Migration-only schema: Prisma manages public; the CDF export contract lives here.
-- Source pruning does not cascade to events; parent erasure is handled by
-- fail-closed DELETE triggers below, including actor redaction on user deletion.
-- Forward recovery: disable DECISION_REPLAY overrides to stop new capture, then
-- repair triggers in a later migration. Retain the export table and its history.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE SCHEMA lakehouse_export;
REVOKE ALL ON SCHEMA lakehouse_export FROM PUBLIC;

CREATE TABLE lakehouse_export.decision_event (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    organization_id text NOT NULL,
    project_id text,
    subject_type text NOT NULL,
    subject_id text,
    event_type text NOT NULL,
    from_state text,
    to_state text,
    actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'ai', 'system', 'unknown')),
    actor_id text,
    related_subject_id text,
    feature_key text,
    model text,
    prompt_version_id text,
    payload jsonb,
    schema_version integer NOT NULL DEFAULT 1
);
CREATE INDEX decision_event_actor ON lakehouse_export.decision_event (actor_id);
CREATE INDEX decision_event_project_time ON lakehouse_export.decision_event (project_id, occurred_at);
CREATE INDEX decision_event_organization_time ON lakehouse_export.decision_event (organization_id, occurred_at);
ALTER TABLE lakehouse_export.decision_event REPLICA IDENTITY FULL;
ALTER TABLE lakehouse_export.decision_event ENABLE ROW LEVEL SECURITY;
-- The SECURITY DEFINER functions and table share the migration owner. Do not
-- FORCE RLS: owner writes/purges must see the full scope without bypass grants.
-- Accepted trade-off: the owner role's own reads of this table are unfiltered.
ALTER TABLE lakehouse_export.decision_event NO FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lakehouse_export.decision_event
    USING (current_setting('app.tenant_type', true) = 'organization'
        AND organization_id = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.tenant_type', true) = 'organization'
        AND organization_id = current_setting('app.tenant_id', true));
-- apply-rls-direct preserves the owner exemption and tenant policy, removes
-- export bypass policies, and grants schema usage/SELECT to provisioned roles.


-- Client labels use explicit outcome-writer allowlists; models/prompts must
-- exist in their catalogs. CUID/UUID shape constrains ids, without asserting
-- that a subject or actor exists. Unknown metadata does not drop the event.
CREATE FUNCTION lakehouse_export.sanitize_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.organization_id IS NULL OR NEW.organization_id !~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$'
        OR (NEW.project_id IS NOT NULL AND NEW.project_id !~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$') THEN
        RETURN NULL;
    END IF;
    IF NEW.id IS NULL OR NEW.id !~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.id := gen_random_uuid()::text; END IF;
    NEW.subject_type := CASE WHEN NEW.subject_type IN (
        'backlog_proposal','backlog_proposal_application','story_duplicate_link','story',
        'spec-patch','publishing-short-post','publishing-linkedin-post','publishing-blog-post',
        'publishing-case-study','publishing-stakeholder-email','publishing-analysis','publishing-topic',
        'publishing-webinar-script','publishing-newsletter-blurb') THEN NEW.subject_type ELSE 'unknown' END;
    NEW.subject_id := CASE WHEN NEW.subject_id ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.subject_id END;
    NEW.actor_id := CASE WHEN NEW.actor_id ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.actor_id END;
    NEW.related_subject_id := CASE WHEN NEW.related_subject_id ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.related_subject_id END;
    NEW.prompt_version_id := CASE WHEN NEW.prompt_version_id ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$'
        AND EXISTS (SELECT 1 FROM public.prompt_version v WHERE v.id = NEW.prompt_version_id)
        THEN NEW.prompt_version_id END;
    NEW.feature_key := CASE WHEN NEW.feature_key IS NULL THEN NULL
        WHEN NEW.feature_key IN ('maturation','publishing-suite') THEN NEW.feature_key ELSE 'unknown' END;
    NEW.model := CASE WHEN NEW.model IS NULL THEN NULL WHEN EXISTS (SELECT 1 FROM public.ai_model m WHERE m."canonicalName" = NEW.model)
        THEN NEW.model ELSE 'unknown' END;
    NEW.event_type := CASE WHEN NEW.event_type IN ('proposed','status_changed','change_applied',
        'rated','re_rated','rating_cleared','duplicate_detected','duplicate_dismissed','duplicate_resolved','duplicate_status_changed','story_edited')
        THEN NEW.event_type ELSE 'unknown' END;
    NEW.actor_kind := CASE WHEN NEW.actor_kind IN ('human','ai','system','unknown') THEN NEW.actor_kind ELSE 'unknown' END;
    NEW.from_state := CASE WHEN NEW.from_state IS NULL THEN NULL
        WHEN NEW.from_state ~ '^[A-Z][A-Z0-9_]{0,63}$' THEN NEW.from_state ELSE 'unknown' END;
    NEW.to_state := CASE WHEN NEW.to_state IS NULL THEN NULL
        WHEN NEW.to_state ~ '^[A-Z][A-Z0-9_]{0,63}$' THEN NEW.to_state ELSE 'unknown' END;
    IF NEW.event_type IN ('proposed','status_changed') THEN
        NEW.payload := jsonb_build_object(
            'source', CASE WHEN NEW.payload->>'source' IN ('TEAMS_CHANNEL','TEAMS_CHAT','SLACK_CHANNEL',
                'AI_UPDATE_SIDEBAR','MONITORED_MEETING','SCOPE_DOCUMENT','ROADMAP_RECOMMENDATION',
                'LOG_MONITOR','INCIDENT_CLUSTER') THEN NEW.payload->>'source' ELSE 'unknown' END,
            'changeCount', CASE WHEN jsonb_typeof(NEW.payload->'changeCount') = 'number'
                THEN LEAST(GREATEST((NEW.payload->>'changeCount')::numeric, 0), 2147483647)::integer END,
            'errorClass', CASE WHEN NEW.payload->>'errorClass' IS NULL THEN NULL
                WHEN NEW.payload->>'errorClass' IN ('TimedOut','Cancelled','TemporalScheduleFailed','PmNotFoundError',
                    'PmAuthError','Error','UnknownError','default','not_connected','not_configured','create_orphan',
                    'context_length','provider_quota','provider_rate_limit','provider_overloaded','subscription_exhausted',
                    'subscription_reconnect','provider_unavailable','output_limit','schema_parse','provider_not_configured',
                    'provider_content_filter','transient_or_unknown') THEN NEW.payload->>'errorClass' ELSE 'unknown' END);
    ELSIF NEW.event_type = 'change_applied' THEN
        NEW.payload := jsonb_build_object(
            'changeIndex', CASE WHEN jsonb_typeof(NEW.payload->'changeIndex') = 'number'
                THEN LEAST(GREATEST((NEW.payload->>'changeIndex')::numeric, 0), 2147483647)::integer END,
            'action', CASE WHEN NEW.payload->>'action' IN ('create','update') THEN NEW.payload->>'action' ELSE 'unknown' END,
            'createdEntityType', CASE WHEN NEW.payload->>'createdEntityType' IS NULL THEN NULL
                WHEN NEW.payload->>'createdEntityType' IN ('epic','feature','story','bug') THEN NEW.payload->>'createdEntityType' ELSE 'unknown' END,
            'createdEntityId', CASE WHEN NEW.payload->>'createdEntityId' ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.payload->>'createdEntityId' END);
    ELSIF NEW.event_type = 'duplicate_detected' THEN
        NEW.payload := jsonb_build_object(
            'similarity', CASE WHEN jsonb_typeof(NEW.payload->'similarity') = 'number'
                THEN round(LEAST(GREATEST((NEW.payload->>'similarity')::numeric, 0), 1), 4) END,
            'confidence', CASE WHEN jsonb_typeof(NEW.payload->'confidence') = 'number'
                THEN round(LEAST(GREATEST((NEW.payload->>'confidence')::numeric, 0), 1), 4) END,
            'linkType', CASE WHEN NEW.payload->>'linkType' IN ('DUPLICATE','OVERLAP') THEN NEW.payload->>'linkType' ELSE 'unknown' END);
    ELSE
        NEW.payload := NULL;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.sanitize_event() FROM PUBLIC;
CREATE TRIGGER decision_event_sanitize BEFORE INSERT ON lakehouse_export.decision_event
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.sanitize_event();

CREATE FUNCTION lakehouse_export.capture_enabled(org text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    -- An unresolved tenant does not inherit a globally enabled flag.
    IF org IS NULL THEN RETURN false; END IF;
    RETURN COALESCE(
        (SELECT o.enabled FROM public.organization_feature_flag_override o
            WHERE o.key = 'DECISION_REPLAY' AND o."organizationId" = org),
        (SELECT g.enabled FROM public.feature_flag_override g WHERE g.key = 'DECISION_REPLAY'),
        false);
EXCEPTION WHEN OTHERS THEN
    -- Deliberate fail-open for the business write; capture itself defaults off.
    RAISE WARNING 'decision_event capture failed (flag), SQLSTATE %', SQLSTATE;
    RETURN false;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_enabled(text) FROM PUBLIC;

-- Attribution table (NULL means skip). Only the resolved organization is
-- passed to capture_enabled; NULL row metadata is not tenant proof for clients.
-- Source                                    Required proof
-- pending_backlog_proposal                   project -> non-NULL org P;
-- pending_backlog_proposal_application       same, using parent proposal metadata;
-- story_duplicate_link, user_story           same, no row organization column.
-- For these server sources: non-NULL row org different from P -> skip, else P.
-- ai_outcome_event                           non-NULL row org O; absent project
-- -> O; supplied project must resolve to exactly O, else skip (including NULL P).
CREATE FUNCTION lakehouse_export.resolve_event_org(source_kind text, row_org text, project_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE project_org text;
BEGIN
    CASE source_kind
        WHEN 'pending_backlog_proposal', 'pending_backlog_proposal_application',
             'story_duplicate_link', 'user_story' THEN
            IF project_id IS NULL THEN RETURN NULL; END IF;
            SELECT p."organizationId" INTO project_org FROM public.project p WHERE p.id = project_id;
            IF project_org IS NULL OR (row_org IS NOT NULL AND row_org <> project_org) THEN RETURN NULL; END IF;
            RETURN project_org;
        WHEN 'ai_outcome_event' THEN
            IF row_org IS NULL THEN RETURN NULL; END IF;
            IF project_id IS NULL THEN RETURN row_org; END IF;
            SELECT p."organizationId" INTO project_org FROM public.project p WHERE p.id = project_id;
            IF project_org IS DISTINCT FROM row_org THEN RETURN NULL; END IF;
            RETURN row_org;
        ELSE RETURN NULL;
    END CASE;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.resolve_event_org(text, text, text) FROM PUBLIC;

-- Status writer inventory (paths relative to packages/ unless stated).
-- DuplicateLinkStatus: queries/projects/duplicate-links.ts under database/prisma/:
-- INSERT -> PENDING: upsertPendingDuplicateLink:158-169 (create branch).
-- INSERT -> NOT_DUPLICATE: recordDistinctVerdict:226-238 (negative cache).
-- UPDATE NOT_DUPLICATE -> PENDING: upsertPendingDuplicateLink:180-189.
-- UPDATE PENDING -> DISMISSED: dismissDuplicateLink:397-403.
-- UPDATE PENDING -> RESOLVED: mergeDuplicateStories:621-631 (all pending links
-- touching the retired story, not only the selected pair).
-- The locations near 314/376 are reads; upsert update branches and :250 only
-- refresh metadata. No other runtime status writers were found.
--
-- Implemented duplicate transition table:
-- INSERT -> PENDING                     duplicate_detected       ai
-- INSERT -> any other status            none
-- UPDATE NOT_DUPLICATE -> PENDING        duplicate_detected       ai
-- UPDATE PENDING -> DISMISSED            duplicate_dismissed      human
-- UPDATE PENDING -> RESOLVED             duplicate_resolved       human
-- UPDATE any other DISTINCT pair        duplicate_status_changed system
-- UPDATE same status / DELETE           none
-- Detection includes rounded scores and link type; only the two human rows
-- carry resolvedById. A retained resolver cannot attribute another transition.
--
-- PendingBacklogProposalStatus writers (database/prisma/queries/projects/
-- pending-backlog-proposals.ts unless another path is given):
-- INSERT -> PENDING: createPendingBacklogProposal:153; temporal/src/activities/
-- teams-chat-monitor/analyze-chat-messages.ts:310 and
-- teams-channel-monitor/analyze-channel-messages.ts:663 (schema default).
-- UPDATE * -> APPROVED: markPendingProposalApproved:316 (no status predicate).
-- UPDATE * -> APPLIED: markPendingProposalApplied:330 (no status predicate).
-- UPDATE * -> FAILED: markPendingProposalFailed:369 (no status predicate).
-- UPDATE PENDING/APPLYING -> FAILED: stopApplyingProposal:452.
-- UPDATE PENDING/APPROVED/APPLYING -> FAILED: timeOutStaleApply:513.
-- UPDATE PENDING/FAILED/BACKLOG -> REJECTED: markPendingProposalRejected:595.
-- UPDATE PENDING -> BACKLOG: markPendingProposalBacklog:627.
-- UPDATE PENDING/FAILED[/BACKLOG] -> APPLYING: claimPendingProposalForApply:766.
-- UPDATE FAILED -> PENDING: returnFailedRecommendationToReview:793.
-- UPDATE APPLYING -> PENDING/APPLIED/FAILED: finalizeClaimedProposal:902/940.
-- UPDATE PENDING -> SUPERSEDED: temporal/src/activities/scope-intake/index.ts:1069.
-- UPDATE PENDING -> APPLIED/FAILED: temporal/src/activities/
-- teams-channel-monitor/fetch-channel-cursor.ts:357 (legacy finalization).
-- UPDATE PENDING/APPLYING -> APPLYING: api/modules/projects/procedures/backlog/
-- apply-changes.ts:764 (same-status claim refresh emits nothing).
-- UPDATE FAILED -> APPLIED/APPLYING: api/modules/projects/procedures/backlog/
-- retry-failed-proposal.ts:221/272 and retry-all-failed-proposals.ts:260/318.
-- Other proposal writes found update metadata, not status (:305/408/729/857,
-- fetch-channel-cursor.ts:329, recurring-error-signatures.ts:516, summary backfill).
--
-- Implemented proposal table, for each of the eight listed enum states:
-- INSERT -> any status                  proposed       system
-- UPDATE any DISTINCT pair              status_changed human iff this update
-- changes reviewedAt AND reviewedBy is non-NULL; otherwise system.
-- UPDATE same status / DELETE           none
-- Broad helper writers above have no from-state predicate, so no narrower
-- semantic event is inferred. Both states remain on the event.
CREATE FUNCTION lakehouse_export.status_transition(source_kind text, operation text,
    from_status text, to_status text, review_changed boolean DEFAULT false)
RETURNS TABLE(event_type text, actor_kind text)
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    WITH duplicate_states(status) AS (VALUES
        ('PENDING'), ('DISMISSED'), ('RESOLVED'), ('NOT_DUPLICATE')),
    proposal_states(status) AS (VALUES
        ('PENDING'), ('APPROVED'), ('APPLYING'), ('APPLIED'),
        ('REJECTED'), ('FAILED'), ('SUPERSEDED'), ('BACKLOG')),
    duplicate_rules(op, old_status, new_status, event, actor) AS (VALUES
        ('INSERT', NULL::text, 'PENDING', 'duplicate_detected', 'ai'),
        ('UPDATE', 'NOT_DUPLICATE', 'PENDING', 'duplicate_detected', 'ai'),
        ('UPDATE', 'PENDING', 'DISMISSED', 'duplicate_dismissed', 'human'),
        ('UPDATE', 'PENDING', 'RESOLVED', 'duplicate_resolved', 'human')),
    rules(source, op, old_status, new_status, event, actor) AS (
        SELECT 'story_duplicate_link', d.* FROM duplicate_rules d
        UNION ALL
        SELECT 'story_duplicate_link', 'UPDATE', a.status, b.status,
            'duplicate_status_changed', 'system'
        FROM duplicate_states a CROSS JOIN duplicate_states b
        WHERE a.status <> b.status AND NOT EXISTS (
            SELECT 1 FROM duplicate_rules d WHERE d.op = 'UPDATE'
                AND d.old_status = a.status AND d.new_status = b.status)
        UNION ALL
        SELECT 'pending_backlog_proposal', 'INSERT', NULL, s.status, 'proposed', 'system'
        FROM proposal_states s
        UNION ALL
        SELECT 'pending_backlog_proposal', 'UPDATE', a.status, b.status, 'status_changed', r.actor
        FROM proposal_states a CROSS JOIN proposal_states b
        CROSS JOIN (VALUES (true, 'human'), (false, 'system')) r(review, actor)
        WHERE a.status <> b.status AND r.review = COALESCE(review_changed, false)
    )
    SELECT r.event, r.actor FROM rules r WHERE r.source = source_kind
        AND r.op = operation AND r.old_status IS NOT DISTINCT FROM from_status
        AND r.new_status IS NOT DISTINCT FROM to_status;
$$;
REVOKE ALL ON FUNCTION lakehouse_export.status_transition(text, text, text, text, boolean) FROM PUBLIC;

-- Preflight passes only when the owner sees a row in each probed source/catalog
-- table. Exact RLS-filtered existence probes make empty or hidden tables fail
-- conservatively. RLS-exempt feature-flag control tables are excluded: empty
-- override tables are normal and do not indicate hidden tenant rows.
-- Run when the probed tables have data, before enabling capture on each host.
-- No bypass policy is added. The probe must run without a tenant context, so a
-- caller that has one is refused rather than having it cleared: function SET
-- clauses on app.* settings need superuser (or GRANT SET) on PostgreSQL 15+,
-- and migrations run as the non-superuser app role.
CREATE FUNCTION lakehouse_export.capture_preflight()
RETURNS TABLE(table_name text, owner_sees_rows boolean, passed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE source_table text;
BEGIN
    IF COALESCE(current_setting('app.tenant_type', true), '') NOT IN ('', 'none')
        OR COALESCE(current_setting('app.tenant_id', true), '') <> ''
        OR COALESCE(current_setting('app.user_id', true), '') <> '' THEN
        RAISE EXCEPTION 'capture_preflight() must run without a tenant context'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    FOREACH source_table IN ARRAY ARRAY['project','pending_backlog_proposal',
        'prompt_version','user','organization','ai_model'] LOOP
        table_name := 'public.' || source_table;
        BEGIN
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', source_table) INTO owner_sees_rows;
        EXCEPTION WHEN insufficient_privilege THEN
            owner_sees_rows := false;
        END;
        passed := owner_sees_rows;
        RETURN NEXT;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_preflight() FROM PUBLIC;

-- Each capture exception block rolls back only its export insert. Fail-open is
-- deliberate: a capture bug must not roll back the originating business write.
-- Warnings contain SQLSTATE only, because SQLERRM can contain source data.
-- A single transaction capturing more than about 64 rows pays PostgreSQL
-- subtransaction overhead; the per-row exception blocks preserve fail-open writes.
CREATE FUNCTION lakehouse_export.capture_proposal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text; human_review boolean := false; event text; actor text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        org := lakehouse_export.resolve_event_org('pending_backlog_proposal', NEW."organizationId", NEW."projectId");
        IF NOT lakehouse_export.capture_enabled(org) THEN RETURN NULL; END IF;
        IF TG_OP = 'UPDATE' THEN
            human_review := NEW."reviewedBy" IS NOT NULL
                AND NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt";
        END IF;
        SELECT t.event_type, t.actor_kind INTO event, actor FROM lakehouse_export.status_transition(
            'pending_backlog_proposal', TG_OP,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text END, NEW.status::text, human_review) t;
        IF event IS NULL THEN RETURN NULL; END IF;
        INSERT INTO lakehouse_export.decision_event
            (organization_id, project_id, subject_type, subject_id, event_type,
             from_state, to_state, actor_kind, actor_id, payload)
        VALUES (org, NEW."projectId", 'backlog_proposal', NEW.id,
            event,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text END, NEW.status::text,
            actor, CASE WHEN actor = 'human' THEN NEW."reviewedBy" END,
            jsonb_build_object('source', NEW.source::text, 'changeCount', NEW."changeCount", 'errorClass', NEW."errorClass"));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (proposal), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_proposal() FROM PUBLIC;
CREATE TRIGGER decision_event_proposal_insert AFTER INSERT ON public.pending_backlog_proposal
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_proposal();
CREATE TRIGGER decision_event_proposal_status AFTER UPDATE OF status ON public.pending_backlog_proposal
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION lakehouse_export.capture_proposal();

CREATE FUNCTION lakehouse_export.capture_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text; project_id text; row_org text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        SELECT b."organizationId", b."projectId" INTO row_org, project_id
            FROM public.pending_backlog_proposal b WHERE b.id = NEW."proposalId";
        org := lakehouse_export.resolve_event_org('pending_backlog_proposal_application', row_org, project_id);
        IF lakehouse_export.capture_enabled(org) THEN
            INSERT INTO lakehouse_export.decision_event
                (organization_id, project_id, subject_type, subject_id, event_type,
                 related_subject_id, actor_kind, payload)
            VALUES (org, project_id, 'backlog_proposal_application', NEW.id, 'change_applied',
                NEW."proposalId", 'system', jsonb_build_object(
                    'changeIndex', NEW."changeIndex",
                    'action', NEW.action,
                    'createdEntityType', NEW."createdEntityType",
                    'createdEntityId', NEW."createdEntityId"));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (application), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_application() FROM PUBLIC;
CREATE TRIGGER decision_event_application AFTER INSERT ON public.pending_backlog_proposal_application
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_application();

CREATE FUNCTION lakehouse_export.capture_outcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.ai_outcome_event; org text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        -- FK-triggered AFTER events can be queued at depth one. In addition
        -- to the nesting guard, check the deleted row's referenced parents.
        -- A direct rating deletion still has those FK parents; a cascade does not.
        IF TG_OP = 'DELETE' AND (
            (r."userId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = r."userId"))
            OR (r."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organization o WHERE o.id = r."organizationId"))
            OR (r."projectId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.project p WHERE p.id = r."projectId"))
        ) THEN RETURN NULL; END IF;
        org := lakehouse_export.resolve_event_org('ai_outcome_event', r."organizationId", r."projectId");
        IF lakehouse_export.capture_enabled(org) THEN
            INSERT INTO lakehouse_export.decision_event
                (organization_id, project_id, subject_type, subject_id, event_type,
                 from_state, to_state, actor_kind, actor_id, feature_key, model, prompt_version_id)
            VALUES (org, r."projectId", r."subjectType", r."subjectId",
                CASE TG_OP WHEN 'INSERT' THEN 'rated' WHEN 'UPDATE' THEN 're_rated' ELSE 'rating_cleared' END,
                CASE WHEN TG_OP <> 'INSERT' THEN OLD.outcome::text END,
                CASE WHEN TG_OP <> 'DELETE' THEN NEW.outcome::text END,
                CASE WHEN r."userId" IS NULL THEN 'unknown' ELSE 'human' END,
                r."userId", r."featureKey", r."modelCanonicalName", r."promptVersionId");
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (outcome), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_outcome() FROM PUBLIC;
CREATE TRIGGER decision_event_outcome_insert AFTER INSERT ON public.ai_outcome_event
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_outcome();
CREATE TRIGGER decision_event_outcome_update AFTER UPDATE OF outcome ON public.ai_outcome_event
    FOR EACH ROW WHEN (OLD.outcome IS DISTINCT FROM NEW.outcome)
    EXECUTE FUNCTION lakehouse_export.capture_outcome();
CREATE TRIGGER decision_event_outcome_delete AFTER DELETE ON public.ai_outcome_event
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_outcome();

-- Accepted race: a dismissal can commit concurrently after user erasure and
-- retain resolvedById in its event because that source column has no user FK.
CREATE FUNCTION lakehouse_export.capture_duplicate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text; event text; actor text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        org := lakehouse_export.resolve_event_org('story_duplicate_link', NULL, NEW."projectId");
        IF NOT lakehouse_export.capture_enabled(org) THEN RETURN NULL; END IF;
        SELECT t.event_type, t.actor_kind INTO event, actor FROM lakehouse_export.status_transition(
            'story_duplicate_link', TG_OP,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text END, NEW.status::text) t;
        IF event IS NULL THEN RETURN NULL; END IF;
        INSERT INTO lakehouse_export.decision_event
            (organization_id, project_id, subject_type, subject_id, event_type,
             from_state, to_state, actor_kind, actor_id, payload)
        VALUES (org, NEW."projectId", 'story_duplicate_link', NEW.id, event,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text END, NEW.status::text,
            actor, CASE WHEN actor = 'human' THEN NEW."resolvedById" END,
            CASE WHEN event = 'duplicate_detected' THEN jsonb_build_object(
                'similarity', NEW.similarity, 'confidence', NEW.confidence, 'linkType', NEW."linkType"::text) END);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (duplicate), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_duplicate() FROM PUBLIC;
CREATE TRIGGER decision_event_duplicate_insert AFTER INSERT ON public.story_duplicate_link
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_duplicate();
CREATE TRIGGER decision_event_duplicate AFTER UPDATE OF status ON public.story_duplicate_link
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION lakehouse_export.capture_duplicate();

CREATE FUNCTION lakehouse_export.capture_story_edit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        org := lakehouse_export.resolve_event_org('user_story', NULL, NEW."projectId");
        IF lakehouse_export.capture_enabled(org) THEN
            INSERT INTO lakehouse_export.decision_event
                (organization_id, project_id, subject_type, subject_id, event_type,
                 related_subject_id, actor_kind)
            VALUES (org, NEW."projectId", 'story', NEW.id, 'story_edited', NEW."createdFromProposalId",
                CASE NEW."lastEditedSource"::text
                    WHEN 'MANUAL' THEN 'human' WHEN 'CONFLICT_RESOLUTION' THEN 'human'
                    WHEN 'AI_BACKLOG_UPDATE' THEN 'ai' WHEN 'AI_MATURATION' THEN 'ai'
                    WHEN 'PM_PULL' THEN 'system' ELSE 'unknown' END);
            -- lastEditedByName is a name, not an id: intentionally omitted.
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (story), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_story_edit() FROM PUBLIC;
-- lastEditedAt is the semantic-edit clock; updatedAt/summary/hash writes do
-- not move it. Source/name alone are attribution, not another edit.
CREATE TRIGGER decision_event_story_edit AFTER UPDATE OF "lastEditedAt" ON public.user_story
    FOR EACH ROW WHEN (NEW."createdFromProposalId" IS NOT NULL
        AND OLD."lastEditedAt" IS DISTINCT FROM NEW."lastEditedAt")
    EXECUTE FUNCTION lakehouse_export.capture_story_edit();

-- Append-only enforcement also applies to owners and bypass-policy roles.
-- Ordinary attempts to rewrite history fail; parent erasure may delete/redact.
CREATE FUNCTION lakehouse_export.reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    -- A custom GUC alone is caller-settable. A direct mutation is depth one
    -- even if a caller sets it; only nested, non-TRUNCATE purge writes pass.
    IF TG_OP = 'TRUNCATE' OR pg_trigger_depth() < 2
        OR current_setting('lakehouse_export.purge', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'decision_event is append-only' USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.reject_event_mutation() FROM PUBLIC;
CREATE TRIGGER decision_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON lakehouse_export.decision_event
    FOR EACH STATEMENT EXECUTE FUNCTION lakehouse_export.reject_event_mutation();
-- Erasure is deliberately fail-closed: a failed purge/redaction aborts the
-- parent deletion. No exception swallowing here. The table owner is exempt
-- from RLS, so erasure does not depend on deployment-time bypass grants.
CREATE FUNCTION lakehouse_export.purge_decision_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    PERFORM set_config('lakehouse_export.purge', 'on', true);
    IF TG_TABLE_NAME = 'organization' THEN
        DELETE FROM lakehouse_export.decision_event WHERE organization_id = OLD.id;
    ELSIF TG_TABLE_NAME = 'project' THEN
        DELETE FROM lakehouse_export.decision_event WHERE project_id = OLD.id;
    ELSIF TG_TABLE_NAME = 'user' THEN
        UPDATE lakehouse_export.decision_event SET actor_id = NULL WHERE actor_id = OLD.id;
    END IF;
    PERFORM set_config('lakehouse_export.purge', 'off', true);
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.purge_decision_events() FROM PUBLIC;
CREATE TRIGGER decision_event_purge_organization AFTER DELETE ON public.organization
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.purge_decision_events();
CREATE TRIGGER decision_event_purge_project AFTER DELETE ON public.project
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.purge_decision_events();
CREATE TRIGGER decision_event_purge_user AFTER DELETE ON public."user"
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.purge_decision_events();

COMMIT;

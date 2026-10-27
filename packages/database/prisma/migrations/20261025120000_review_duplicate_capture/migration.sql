-- Add separate duplicate resolutions and capture review outcomes without free text.
-- Forward recovery: disable DECISION_REPLAY and replace functions in a later migration.
-- Existing sources and events are unchanged; no historical backfill is performed.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- migration-lint: allow unbatched-backfill - INSERT SELECT is inside a trigger function over its transition table; migration installation copies no rows.

-- CreateTable
CREATE TABLE "pending_backlog_proposal_duplicate_resolution" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "changeIndex" INTEGER NOT NULL,
    "existingEntityType" TEXT,
    "existingEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_backlog_proposal_duplicate_resolution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_duplicate_resolution_proposalId_idx" ON "pending_backlog_proposal_duplicate_resolution"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_backlog_proposal_duplicate_resolution_proposalId_ch_key" ON "pending_backlog_proposal_duplicate_resolution"("proposalId", "changeIndex");

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal_duplicate_resolution" ADD CONSTRAINT "pending_backlog_proposal_duplicate_resolution_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE OR REPLACE FUNCTION lakehouse_export.sanitize_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF NEW.organization_id IS NULL OR NEW.organization_id !~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$'
        OR (NEW.project_id IS NOT NULL AND NEW.project_id !~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$') THEN
        RETURN NULL;
    END IF;
    IF NEW.id IS NULL OR NEW.id !~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.id := gen_random_uuid()::text; END IF;
    NEW.subject_type := CASE WHEN NEW.subject_type IN (
        'backlog_proposal','backlog_proposal_application','story_duplicate_link','story',
        'backlog_proposal_review','backlog_proposal_review_entry','backlog_proposal_duplicate_resolution',
        'spec-patch','publishing-short-post','publishing-linkedin-post','publishing-blog-post',
        'publishing-case-study','publishing-stakeholder-email','publishing-analysis','publishing-topic',
        'publishing-webinar-script','publishing-newsletter-blurb',
        'feature-spec-draft','document-draft','agent-document-draft','prompt-enhancement-draft') THEN NEW.subject_type ELSE 'unknown' END;
    NEW.subject_id := CASE WHEN NEW.subject_id ~ '^(backlog-apply-op-[0-9a-f]{64}|c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.subject_id END;
    NEW.actor_id := CASE WHEN NEW.actor_id ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.actor_id END;
    NEW.related_subject_id := CASE WHEN NEW.related_subject_id ~ '^(backlog-apply-op-[0-9a-f]{64}|c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.related_subject_id END;
    NEW.prompt_version_id := CASE WHEN NEW.prompt_version_id ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$'
        AND EXISTS (SELECT 1 FROM public.prompt_version v WHERE v.id = NEW.prompt_version_id)
        THEN NEW.prompt_version_id END;
    NEW.feature_key := CASE WHEN NEW.feature_key IS NULL THEN NULL
        WHEN NEW.feature_key IN ('maturation','publishing-suite','document-generation','prompt-enhancement','agent-document-generation') THEN NEW.feature_key ELSE 'unknown' END;
    NEW.model := CASE WHEN NEW.model IS NULL THEN NULL WHEN EXISTS (SELECT 1 FROM public.ai_model m WHERE m."canonicalName" = NEW.model)
        THEN NEW.model ELSE 'unknown' END;
    NEW.event_type := CASE WHEN NEW.event_type IN ('proposed','status_changed','change_applied',
        'proposal_reviewed','change_reviewed','change_deduplicated',
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
    ELSIF NEW.event_type = 'proposal_reviewed' THEN
        NEW.payload := jsonb_build_object('source', CASE WHEN NEW.payload->>'source' IN ('TEAMS_CHANNEL','TEAMS_CHAT','SLACK_CHANNEL','AI_UPDATE_SIDEBAR','MONITORED_MEETING','SCOPE_DOCUMENT','ROADMAP_RECOMMENDATION','LOG_MONITOR','INCIDENT_CLUSTER') THEN NEW.payload->>'source' ELSE 'unknown' END,
            'offeredCount', CASE WHEN jsonb_typeof(NEW.payload->'offeredCount') = 'number' THEN LEAST(GREATEST((NEW.payload->>'offeredCount')::numeric, 0), 2147483647)::integer END, 'selectedCount', CASE WHEN jsonb_typeof(NEW.payload->'selectedCount') = 'number' THEN LEAST(GREATEST((NEW.payload->>'selectedCount')::numeric, 0), 2147483647)::integer END,
            'offeredListComplete', CASE WHEN jsonb_typeof(NEW.payload->'offeredListComplete') = 'boolean' THEN (NEW.payload->>'offeredListComplete')::boolean END);
    ELSIF NEW.event_type = 'change_reviewed' THEN
        NEW.payload := jsonb_build_object(
            'reviewId', CASE WHEN NEW.payload->>'reviewId' ~ '^(c[a-z0-9]{24}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$' THEN NEW.payload->>'reviewId' END,
            'offeredIndex', CASE WHEN jsonb_typeof(NEW.payload->'offeredIndex') = 'number' THEN LEAST(GREATEST((NEW.payload->>'offeredIndex')::numeric, 0), 2147483647)::integer END, 'changeIndex', CASE WHEN jsonb_typeof(NEW.payload->'changeIndex') = 'number' THEN LEAST(GREATEST((NEW.payload->>'changeIndex')::numeric, 0), 2147483647)::integer END,
            'selected', CASE WHEN jsonb_typeof(NEW.payload->'selected') = 'boolean' THEN (NEW.payload->>'selected')::boolean END);
    ELSIF NEW.event_type = 'change_deduplicated' THEN
        NEW.payload := jsonb_build_object('changeIndex', CASE WHEN jsonb_typeof(NEW.payload->'changeIndex') = 'number' THEN LEAST(GREATEST((NEW.payload->>'changeIndex')::numeric, 0), 2147483647)::integer END,
            'existingEntityType', CASE WHEN NEW.payload->>'existingEntityType' IS NULL THEN NULL
                WHEN NEW.payload->>'existingEntityType' IN ('epic','feature','story','bug') THEN NEW.payload->>'existingEntityType' ELSE 'unknown' END);
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

CREATE OR REPLACE FUNCTION lakehouse_export.resolve_event_org(source_kind text, row_org text, project_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE project_org text;
BEGIN
    CASE source_kind
        WHEN 'pending_backlog_proposal', 'pending_backlog_proposal_application',
             'story_duplicate_link', 'user_story', 'pending_backlog_proposal_review',
             'pending_backlog_proposal_review_entry', 'pending_backlog_proposal_duplicate_resolution' THEN
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

CREATE FUNCTION lakehouse_export.capture_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text; project_id text; row_org text; proposal_source text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        SELECT b."organizationId", b."projectId", b.source::text INTO row_org, project_id, proposal_source
            FROM public.pending_backlog_proposal b WHERE b.id = NEW."proposalId";
        org := lakehouse_export.resolve_event_org('pending_backlog_proposal_review', row_org, project_id);
        IF lakehouse_export.capture_enabled(org) THEN
            INSERT INTO lakehouse_export.decision_event
                (organization_id, project_id, subject_type, subject_id, event_type,
                 related_subject_id, actor_kind, actor_id, payload)
            VALUES (org, project_id, 'backlog_proposal_review', NEW.id, 'proposal_reviewed',
                NEW."proposalId", 'human', NEW."reviewedBy", jsonb_build_object('source', proposal_source, 'offeredCount', NEW."offeredCount", 'selectedCount', NEW."selectedCount", 'offeredListComplete', NEW."offeredListComplete"));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (review), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_review() FROM PUBLIC;
CREATE TRIGGER decision_event_review AFTER INSERT ON public.pending_backlog_proposal_review
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_review();

CREATE FUNCTION lakehouse_export.capture_duplicate_resolution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text; project_id text; row_org text; proposal_source text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        SELECT b."organizationId", b."projectId", b.source::text INTO row_org, project_id, proposal_source
            FROM public.pending_backlog_proposal b WHERE b.id = NEW."proposalId";
        org := lakehouse_export.resolve_event_org('pending_backlog_proposal_duplicate_resolution', row_org, project_id);
        IF lakehouse_export.capture_enabled(org) THEN
            INSERT INTO lakehouse_export.decision_event
                (organization_id, project_id, subject_type, subject_id, event_type,
                 related_subject_id, actor_kind, actor_id, payload)
            VALUES (org, project_id, 'backlog_proposal_duplicate_resolution', NEW.id, 'change_deduplicated',
                NEW."proposalId", 'system', NULL, jsonb_build_object('changeIndex', NEW."changeIndex", 'existingEntityType', NEW."existingEntityType"));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (duplicate_resolution), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_duplicate_resolution() FROM PUBLIC;
CREATE TRIGGER decision_event_duplicate_resolution AFTER INSERT ON public.pending_backlog_proposal_duplicate_resolution
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_duplicate_resolution();

-- A createMany can contain 10,000 entries. Materialize scope and the flag once
-- per proposal; only the scalar sanitizer runs once per exported entry.
CREATE FUNCTION lakehouse_export.capture_review_entries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        WITH proposals AS MATERIALIZED (
            SELECT b.id, b."projectId", lakehouse_export.resolve_event_org(
                'pending_backlog_proposal_review_entry', b."organizationId", b."projectId") AS org
            FROM public.pending_backlog_proposal b
            JOIN (SELECT DISTINCT "proposalId" FROM inserted_entries) n ON n."proposalId" = b.id
        ), enabled AS MATERIALIZED (
            SELECT * FROM proposals WHERE lakehouse_export.capture_enabled(org)
        )
        INSERT INTO lakehouse_export.decision_event
            (organization_id, project_id, subject_type, subject_id, event_type,
             related_subject_id, actor_kind, actor_id, payload)
        SELECT p.org, p."projectId", 'backlog_proposal_review_entry', e.id, 'change_reviewed',
            e."proposalId", 'human', r."reviewedBy", jsonb_build_object(
                'reviewId', e."reviewId", 'offeredIndex', e."offeredIndex",
                'changeIndex', e."changeIndex", 'selected', e.selected)
        FROM inserted_entries e JOIN enabled p ON p.id = e."proposalId"
        JOIN public.pending_backlog_proposal_review r ON r.id = e."reviewId" AND r."proposalId" = e."proposalId";
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'decision_event capture failed (review_entries), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_review_entries() FROM PUBLIC;
CREATE TRIGGER decision_event_review_entries AFTER INSERT ON public.pending_backlog_proposal_review_entry
    REFERENCING NEW TABLE AS inserted_entries
    FOR EACH STATEMENT EXECUTE FUNCTION lakehouse_export.capture_review_entries();

COMMIT;

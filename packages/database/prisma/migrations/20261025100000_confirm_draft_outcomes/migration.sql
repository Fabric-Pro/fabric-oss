-- Add AI draft verdict feature keys and subject types to Decision Replay export allowlists.
-- Forward recovery: replace this function in a later migration; existing events
-- are unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';

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
COMMIT;

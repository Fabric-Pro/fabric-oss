-- CDF export contract for delivery analytics. This migration-only table lives
-- outside Prisma's managed public schema. Forward recovery: disable the
-- DELIVERY_ANALYTICS override to stop capture, then repair triggers in a later
-- migration. Retain the export table and its history until erasure is required.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE lakehouse_export.delivery_event (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    organization_id text NOT NULL,
    project_id text NOT NULL,
    subject_type text NOT NULL CHECK (subject_type IN ('story', 'coding_run')),
    subject_id text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('created', 'stage_changed', 'status_changed')),
    from_state text,
    to_state text,
    schema_version integer NOT NULL DEFAULT 1
);
CREATE INDEX delivery_event_project_time ON lakehouse_export.delivery_event (project_id, occurred_at);
CREATE INDEX delivery_event_organization_time ON lakehouse_export.delivery_event (organization_id, occurred_at);
ALTER TABLE lakehouse_export.delivery_event REPLICA IDENTITY FULL;
ALTER TABLE lakehouse_export.delivery_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE lakehouse_export.delivery_event NO FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lakehouse_export.delivery_event
    USING (current_setting('app.tenant_type', true) = 'organization'
        AND organization_id = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.tenant_type', true) = 'organization'
        AND organization_id = current_setting('app.tenant_id', true));

CREATE FUNCTION lakehouse_export.delivery_capture_enabled(org text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF org IS NULL THEN RETURN false; END IF;
    RETURN COALESCE(
        (SELECT o.enabled FROM public.organization_feature_flag_override o
            WHERE o.key = 'DELIVERY_ANALYTICS' AND o."organizationId" = org),
        (SELECT g.enabled FROM public.feature_flag_override g WHERE g.key = 'DELIVERY_ANALYTICS'),
        false);
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'delivery_event capture failed (flag), SQLSTATE %', SQLSTATE;
    RETURN false;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.delivery_capture_enabled(text) FROM PUBLIC;

CREATE FUNCTION lakehouse_export.delivery_project_org(project_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text;
BEGIN
    IF project_id IS NULL THEN RETURN NULL; END IF;
    SELECT p."organizationId" INTO org FROM public.project p WHERE p.id = project_id;
    RETURN org;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.delivery_project_org(text) FROM PUBLIC;

CREATE FUNCTION lakehouse_export.delivery_capture_preflight()
RETURNS TABLE(table_name text, owner_sees_rows boolean, passed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE source_table text;
BEGIN
    IF COALESCE(current_setting('app.tenant_type', true), '') NOT IN ('', 'none')
        OR COALESCE(current_setting('app.tenant_id', true), '') <> ''
        OR COALESCE(current_setting('app.user_id', true), '') <> '' THEN
        RAISE EXCEPTION 'delivery_capture_preflight() must run without a tenant context'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    FOREACH source_table IN ARRAY ARRAY['project', 'user_story', 'coding_run'] LOOP
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
REVOKE ALL ON FUNCTION lakehouse_export.delivery_capture_preflight() FROM PUBLIC;

CREATE FUNCTION lakehouse_export.capture_story_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text; event text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        org := lakehouse_export.delivery_project_org(NEW."projectId");
        IF NOT lakehouse_export.delivery_capture_enabled(org) THEN RETURN NULL; END IF;
        event := CASE TG_OP
            WHEN 'INSERT' THEN 'created'
            WHEN 'UPDATE' THEN 'stage_changed'
            ELSE NULL END;
        IF event IS NULL THEN RETURN NULL; END IF;
        INSERT INTO lakehouse_export.delivery_event
            (organization_id, project_id, subject_type, subject_id, event_type, from_state, to_state)
        VALUES (org, NEW."projectId", 'story', NEW.id, event,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD."draftingStage"::text END,
            NEW."draftingStage"::text);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'delivery_event capture failed (story), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_story_delivery() FROM PUBLIC;
CREATE TRIGGER delivery_event_story_insert AFTER INSERT ON public.user_story
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_story_delivery();
CREATE TRIGGER delivery_event_story_stage AFTER UPDATE OF "draftingStage" ON public.user_story
    FOR EACH ROW WHEN (OLD."draftingStage" IS DISTINCT FROM NEW."draftingStage")
    EXECUTE FUNCTION lakehouse_export.capture_story_delivery();

CREATE FUNCTION lakehouse_export.capture_coding_run_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org text; event text;
BEGIN
    BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
        org := lakehouse_export.delivery_project_org(NEW."projectId");
        IF NOT lakehouse_export.delivery_capture_enabled(org) THEN RETURN NULL; END IF;
        event := CASE TG_OP
            WHEN 'INSERT' THEN 'created'
            WHEN 'UPDATE' THEN 'status_changed'
            ELSE NULL END;
        IF event IS NULL THEN RETURN NULL; END IF;
        INSERT INTO lakehouse_export.delivery_event
            (organization_id, project_id, subject_type, subject_id, event_type, from_state, to_state)
        VALUES (org, NEW."projectId", 'coding_run', NEW.id, event,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text END,
            NEW.status::text);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'delivery_event capture failed (coding run), SQLSTATE %', SQLSTATE;
    END;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.capture_coding_run_delivery() FROM PUBLIC;
CREATE TRIGGER delivery_event_coding_run_insert AFTER INSERT ON public.coding_run
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.capture_coding_run_delivery();
CREATE TRIGGER delivery_event_coding_run_status AFTER UPDATE OF status ON public.coding_run
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION lakehouse_export.capture_coding_run_delivery();

CREATE FUNCTION lakehouse_export.reject_delivery_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' OR pg_trigger_depth() < 2
        OR current_setting('lakehouse_export.purge', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'delivery_event is append-only' USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.reject_delivery_mutation() FROM PUBLIC;
CREATE TRIGGER delivery_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON lakehouse_export.delivery_event
    FOR EACH STATEMENT EXECUTE FUNCTION lakehouse_export.reject_delivery_mutation();

CREATE FUNCTION lakehouse_export.purge_delivery_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    PERFORM set_config('lakehouse_export.purge', 'on', true);
    IF TG_TABLE_NAME = 'organization' THEN
        DELETE FROM lakehouse_export.delivery_event WHERE organization_id = OLD.id;
    ELSIF TG_TABLE_NAME = 'project' THEN
        DELETE FROM lakehouse_export.delivery_event WHERE project_id = OLD.id;
    END IF;
    PERFORM set_config('lakehouse_export.purge', 'off', true);
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION lakehouse_export.purge_delivery_events() FROM PUBLIC;
CREATE TRIGGER delivery_event_purge_organization AFTER DELETE ON public.organization
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.purge_delivery_events();
CREATE TRIGGER delivery_event_purge_project AFTER DELETE ON public.project
    FOR EACH ROW EXECUTE FUNCTION lakehouse_export.purge_delivery_events();

COMMIT;

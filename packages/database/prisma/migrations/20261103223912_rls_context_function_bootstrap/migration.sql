-- Existing linked-document policies depend on these functions during fresh replay.
-- This prerequisite precedes those policies; existing helpers are preserved verbatim.
DO $bootstrap$
BEGIN
 IF to_regprocedure('public.current_tenant_type()') IS NULL THEN
  EXECUTE $ddl$CREATE FUNCTION public.current_tenant_type() RETURNS TEXT AS $body$
   BEGIN RETURN COALESCE(current_setting('app.tenant_type', true), 'none'); END;
   $body$ LANGUAGE plpgsql STABLE$ddl$;
 END IF;
 IF to_regprocedure('public.current_tenant_id()') IS NULL THEN
  EXECUTE $ddl$CREATE FUNCTION public.current_tenant_id() RETURNS TEXT AS $body$
   BEGIN RETURN current_setting('app.tenant_id', true); END;
   $body$ LANGUAGE plpgsql STABLE$ddl$;
 END IF;
 IF to_regprocedure('public.current_user_id()') IS NULL THEN
  EXECUTE $ddl$CREATE FUNCTION public.current_user_id() RETURNS TEXT AS $body$
   BEGIN RETURN current_setting('app.user_id', true); END;
   $body$ LANGUAGE plpgsql STABLE$ddl$;
 END IF;
END;
$bootstrap$;

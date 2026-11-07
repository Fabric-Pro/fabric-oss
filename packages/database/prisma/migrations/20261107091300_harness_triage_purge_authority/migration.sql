-- Explicit cleanup authority; public operations still enforce current actor rights.
DO $$ DECLARE relation_name text; BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fabric_worker') THEN
  FOREACH relation_name IN ARRAY ARRAY['harness_triage_run','harness_triage_call','harness_triage_budget'] LOOP
   EXECUTE format('CREATE POLICY worker_bypass ON %I TO fabric_worker USING (true) WITH CHECK (true)',relation_name);
  END LOOP;
 END IF;
END $$;

-- Only database triggers may call this helper. Identity comes from the changed
-- source row, never from request input. Restore the caller's RLS context.
CREATE FUNCTION purge_private_triage_bodies(p_org text,p_user text,p_watches text[],p_observation text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item record;
 prior_type text:=current_setting('app.tenant_type',true);
 prior_tenant text:=current_setting('app.tenant_id',true);
 prior_user text:=current_setting('app.user_id',true);
BEGIN
 IF p_org IS NULL OR p_user IS NULL THEN RETURN; END IF;
 PERFORM set_config('app.tenant_type','organization',true),set_config('app.tenant_id',p_org,true),set_config('app.user_id',p_user,true);
 FOR item IN SELECT r.id FROM public.harness_triage_run r
  WHERE r."organizationId"=p_org AND r."userId"=p_user AND EXISTS (
   SELECT 1 FROM jsonb_array_elements(r.evidence) e WHERE (e->>'watchId')=ANY(p_watches) OR (e->>'observationId')=p_observation)
  ORDER BY r.id FOR UPDATE
 LOOP
  UPDATE public.harness_triage_run SET "goalCiphertext"='',"resultCiphertext"=NULL,reviews='{}'::jsonb,
   "cancelRequestedAt"=COALESCE("cancelRequestedAt",now()),
   status=CASE WHEN status IN ('QUEUED','RUNNING') THEN 'CANCELLED' ELSE status END,"updatedAt"=now()
   WHERE id=item.id;
  UPDATE public.harness_triage_call SET "responseCiphertext"=NULL,"updatedAt"=now() WHERE "runId"=item.id;
 END LOOP;
 PERFORM set_config('app.tenant_type',COALESCE(prior_type,''),true),set_config('app.tenant_id',COALESCE(prior_tenant,''),true),set_config('app.user_id',COALESCE(prior_user,''),true);
END $$;
REVOKE ALL ON FUNCTION purge_private_triage_bodies(text,text,text[],text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION purge_private_triage_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source_id text;
BEGIN
 IF TG_TABLE_NAME='delivery_signal_watch' THEN
  source_id:=OLD.id;
  IF TG_OP='UPDATE' THEN
   IF NEW.state<>'DISCONNECTED' AND NEW."integrationId" IS NOT DISTINCT FROM OLD."integrationId" THEN RETURN NEW; END IF;
  END IF;
 ELSE
  source_id:=OLD."watchId";
  IF TG_OP='UPDATE' THEN IF NEW."revokedAt" IS NULL THEN RETURN NEW; END IF; END IF;
 END IF;
 PERFORM public.purge_private_triage_bodies(OLD."organizationId",OLD."userId",ARRAY[source_id]);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER purge_triage_watch ON delivery_signal_watch;
CREATE TRIGGER purge_triage_watch AFTER UPDATE OF state,"integrationId" OR DELETE ON delivery_signal_watch FOR EACH ROW EXECUTE FUNCTION purge_private_triage_source();

CREATE FUNCTION purge_private_triage_observation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.ciphertext IS NOT DISTINCT FROM OLD.ciphertext THEN RETURN NEW; END IF;
 END IF;
 PERFORM public.purge_private_triage_bodies(OLD."organizationId",OLD."userId",ARRAY[]::text[],OLD.id);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER private_triage_observation_purge AFTER UPDATE OF ciphertext OR DELETE ON delivery_signal_observation FOR EACH ROW EXECUTE FUNCTION purge_private_triage_observation();

CREATE FUNCTION purge_private_triage_integration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE owner_row record;
 prior_type text:=current_setting('app.tenant_type',true);
 prior_tenant text:=current_setting('app.tenant_id',true);
 prior_user text:=current_setting('app.user_id',true);
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW."isActive" AND NEW.credentials IS NOT DISTINCT FROM OLD.credentials THEN RETURN NEW; END IF;
 END IF;
 -- Private watches belong to the integration's credential owner. Establish that
 -- identity so FORCE RLS also works for a migration owner without BYPASSRLS.
 IF OLD."organizationId" IS NOT NULL THEN
  PERFORM set_config('app.tenant_type','organization',true),set_config('app.tenant_id',OLD."organizationId",true),set_config('app.user_id',OLD."userId",true);
  FOR owner_row IN SELECT w."organizationId",w."userId",array_agg(w.id ORDER BY w.id) ids FROM public.delivery_signal_watch w
   WHERE w."integrationId"=OLD.id GROUP BY w."organizationId",w."userId" ORDER BY w."organizationId",w."userId"
  LOOP
   PERFORM public.purge_private_triage_bodies(owner_row."organizationId",owner_row."userId",owner_row.ids);
  END LOOP;
  PERFORM set_config('app.tenant_type',COALESCE(prior_type,''),true),set_config('app.tenant_id',COALESCE(prior_tenant,''),true),set_config('app.user_id',COALESCE(prior_user,''),true);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER private_triage_integration_purge BEFORE UPDATE OF "isActive",credentials OR DELETE ON workflow_integration FOR EACH ROW EXECUTE FUNCTION purge_private_triage_integration();

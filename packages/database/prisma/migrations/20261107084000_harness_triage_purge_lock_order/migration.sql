-- Purge takes run then call locks, matching the financial ledger; it never changes charges.
CREATE OR REPLACE FUNCTION purge_private_triage_source() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_id text; should_purge boolean;
BEGIN
 IF TG_TABLE_NAME='delivery_signal_watch' THEN source_id:=OLD.id; ELSE source_id:=OLD."watchId"; END IF;
 IF TG_OP='DELETE' THEN should_purge:=true;
 ELSIF TG_TABLE_NAME='delivery_signal_watch' THEN should_purge:=NEW.state='DISCONNECTED';
 ELSE should_purge:=NEW."revokedAt" IS NOT NULL; END IF;
 IF should_purge THEN
  UPDATE public.harness_triage_run SET "goalCiphertext"='',"resultCiphertext"=NULL,reviews='{}'::jsonb,
   "cancelRequestedAt"=COALESCE("cancelRequestedAt",now()),status=CASE WHEN status IN ('QUEUED','RUNNING') THEN 'CANCELLED' ELSE status END,"updatedAt"=now()
   WHERE "organizationId"=OLD."organizationId" AND "userId"=OLD."userId"
    AND evidence @> jsonb_build_array(jsonb_build_object('watchId',source_id));
  UPDATE public.harness_triage_call SET "responseCiphertext"=NULL,"updatedAt"=now()
   WHERE "runId" IN (SELECT id FROM public.harness_triage_run WHERE "organizationId"=OLD."organizationId" AND "userId"=OLD."userId"
    AND evidence @> jsonb_build_array(jsonb_build_object('watchId',source_id)));
 END IF;
 RETURN OLD;
END $$;

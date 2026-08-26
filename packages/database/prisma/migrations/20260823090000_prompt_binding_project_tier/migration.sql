-- PromptBinding gains a PROJECT tier: ORG-scope bindings narrowed to one
-- project, resolving USER > PROJECT > ORG > SYSTEM. Existing rows keep
-- projectId NULL, which means "the tier's whole tenant" exactly as before.
-- Index/constraint work follows in the sibling migrations so nothing here
-- blocks a populated table.
ALTER TABLE "prompt_binding" ADD COLUMN "projectId" TEXT;

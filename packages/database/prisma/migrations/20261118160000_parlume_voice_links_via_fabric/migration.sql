-- Send Parlume's realtime voice to Fabric for links, on environments that
-- already carry the previous default.
--
-- WHY THIS MIGRATION EXISTS
-- `parlume_realtime_voice` resolves through the SYSTEM default AGENT binding
-- onto a seeded PromptVersion, and seed-prompts-only.ts is INSERT-ONLY for a
-- SYSTEM prompt that already exists: editing PARLUME_REALTIME_VOICE_FALLBACK_BODY
-- reaches fresh installs and nothing else. The previous default told the
-- voice to use post_to_chat for links, so it posted project page and
-- repository addresses it wrote itself, without the meeting-link lookup that
-- typed and spoken requests go through. The bridge now refuses such a post;
-- this tells the voice to ask Fabric instead.
--
-- WHAT IT TARGETS (surgical): the PromptVersion the SYSTEM default AGENT
-- binding points at, only while its content is byte-for-byte the default that
-- 20261026150000_parlume_voice_chat_post_labels wrote (md5 below) and the
-- prompt has never been versioned past the one the seed wrote. An
-- organization's edited prompt is a separate Prompt row or a later version
-- and is never touched.
--
-- migration-lint: allow unbatched-backfill — at most one row: the single
-- PromptVersion behind the SYSTEM default binding of one prompt key; the
-- subquery is the customisation guard, not a set to backfill.

UPDATE "prompt_version" pv
SET content = replace(
	pv.content,
	$old$Use post_to_chat for links, lists and anything people will want to copy, then say briefly that you posted it.$old$,
	$new$When someone asks for a link to a project page, work item, document or repository, use ask_fabric: Fabric looks the address up in this project and posts it, or says it could not find it. Never write or say a web address yourself. Use post_to_chat for lists and anything else people will want to copy, then say briefly that you posted it.$new$
)
FROM "prompt_binding" b, "prompt" p
WHERE b."promptVersionId" = pv.id
  AND p.id = pv."promptId"
  AND p."scope" = 'SYSTEM'
  AND p."key" = 'parlume_realtime_voice'
  AND b."targetType" = 'AGENT'
  AND b."targetKey" = 'parlume_realtime_voice'
  AND b."documentType" = 'GENERAL'
  AND b."storyKind" IS NULL
  AND b."scope" = 'SYSTEM'
  AND b."isDefault" = true
  AND md5(pv.content) = 'f39c333f697d6b97f7c85946669e5e07'
  AND NOT EXISTS (
    SELECT 1
    FROM "prompt_version" v2
    WHERE v2."promptId" = p.id
      AND v2."version" > 1
  );

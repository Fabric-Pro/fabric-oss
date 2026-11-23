-- Tell Parlume's realtime voice to say it is posting to the chat, never that
-- the post is already there, on environments that carry the previous default.
--
-- WHY THIS MIGRATION EXISTS
-- `parlume_realtime_voice` resolves through the SYSTEM default AGENT binding
-- onto a seeded PromptVersion, and seed-prompts-only.ts is INSERT-ONLY for a
-- SYSTEM prompt that already exists: editing PARLUME_REALTIME_VOICE_FALLBACK_BODY
-- reaches fresh installs and nothing else. The previous default said "then say
-- briefly that you posted it", and the voice said "I've posted it in the chat"
-- before the chat showed the post, or when the organizer had turned the chat
-- off and it never appeared.
--
-- WHAT IT TARGETS (surgical): the PromptVersion the SYSTEM default AGENT
-- binding points at, only while it still holds the exact previous sentence and
-- the prompt has never been versioned past the one the seed wrote. An
-- organization's edited prompt is a separate Prompt row or a later version
-- and is never touched.
--
-- migration-lint: allow unbatched-backfill — at most one row: the single
-- PromptVersion behind the SYSTEM default binding of one prompt key; the
-- subquery is the customisation guard, not a set to backfill.

UPDATE "prompt_version" pv
SET content = replace(
	pv.content,
	$old$then say briefly that you posted it. Use read_chat$old$,
	$new$then say briefly that you are posting it there. Never say it is already in the chat: the chat may not show it. Use read_chat$new$
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
  AND strpos(pv.content, $old$then say briefly that you posted it. Use read_chat$old$) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM "prompt_version" v2
    WHERE v2."promptId" = p.id
      AND v2."version" > 1
  );

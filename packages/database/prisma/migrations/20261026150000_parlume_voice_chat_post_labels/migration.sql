-- Tell Parlume's realtime voice that its chat post labels (P1, P2, ...) are
-- not work item IDs, on environments that already carry the previous default.
--
-- WHY THIS MIGRATION EXISTS
-- `parlume_realtime_voice` resolves through the SYSTEM default AGENT binding
-- onto a seeded PromptVersion, and seed-prompts-only.ts is INSERT-ONLY for a
-- SYSTEM prompt that already exists: editing PARLUME_REALTIME_VOICE_FALLBACK_BODY
-- reaches fresh installs and nothing else. In a staging meeting the voice
-- handed Fabric a request about "P1", and the agent answered that there is no
-- P1 identifier: the label only names Parlume's own message in the chat.
--
-- WHAT IT TARGETS (surgical): the PromptVersion the SYSTEM default AGENT
-- binding points at, only while its content is byte-for-byte the default that
-- 20261026120000_parlume_voice_natural_speech wrote (md5 below) and the prompt
-- has never been versioned past the one the seed wrote. An organization's
-- edited prompt is a separate Prompt row or a later version and is never
-- touched.
--
-- migration-lint: allow unbatched-backfill — at most one row: the single
-- PromptVersion behind the SYSTEM default binding of one prompt key; the
-- subquery is the customisation guard, not a set to backfill.

UPDATE "prompt_version" pv
SET content = replace(
	pv.content,
	$old$Use read_chat when someone refers to something in the meeting chat.$old$,
	$new$Use read_chat when someone refers to something in the meeting chat. Your chat posts are labelled P1, P2 and so on; those labels are not work item IDs, so when you ask Fabric about one of them, say what the post said.$new$
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
  AND md5(pv.content) = '3bf9c4cb48761ac652b1fc6c9bae2313'
  AND NOT EXISTS (
    SELECT 1
    FROM "prompt_version" v2
    WHERE v2."promptId" = p.id
      AND v2."version" > 1
  );

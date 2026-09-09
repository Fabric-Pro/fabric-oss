-- Teach the deployed Topic Planning & Analysis prompt that LinkedIn is a
-- content format of its own (Fizzy #1851).
--
-- WHY THIS MIGRATION EXISTS
-- `publishing_topic_planning_analysis` resolves at runtime through the SYSTEM
-- default AGENT binding onto a seeded PromptVersion, and seed-prompts-only.ts
-- is INSERT-ONLY for a SYSTEM prompt that already exists: editing
-- PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY reaches fresh installs and nothing
-- else. The prompt seeded on 2026-08-30, before LINKEDIN_POST existed, so every
-- already-deployed environment offers the LinkedIn tab while its analysis is
-- still working from a list of content types that does not contain LinkedIn —
-- and, worse, from a body that gives it no reason to treat a LinkedIn post as
-- anything but a longer tweet. This carries the two changed paragraphs across.
-- Same shape as 20260826090000_sync_reprioritization_priority_tag_guidance and
-- the three `sync_*_prompt*` migrations before it.
--
-- WHAT IT TARGETS (surgical): the single PromptVersion the SYSTEM default AGENT
-- binding points at, and only while that prompt has never been versioned past
-- the one the seed wrote. ORG/USER forks are separate Prompt rows and are never
-- reachable from this predicate at all.
--
-- WHY THE `NOT EXISTS` GUARD, GIVEN THE BINDING ALREADY NARROWS US TO ONE ROW
-- An admin editing a SYSTEM prompt in the UI goes through createPromptVersion,
-- which inserts version N+1 and cascades the same-scope bindings onto it. So a
-- customised prompt is exactly a prompt carrying a version above 1, and this
-- statement declines to touch one — it does not matter what they changed, or
-- whether they changed the paragraphs below. Prod was checked on 2026-09-09 and
-- had no such version; staging was not, and does not need to be, because the
-- guard is the check rather than a record of one having been done.
--
-- The two guards below do DIFFERENT jobs and neither substitutes for the other.
-- `NOT EXISTS` is the customisation guard, and the only one: a customised body
-- that happens not to mention LinkedIn passes `NOT LIKE` untouched and would be
-- rewritten by `replace()` quite happily, so it is the version check alone that
-- declines it. `NOT LIKE`, with `replace()` behind it, is the idempotency
-- guard: a second apply, or an apply against a freshly-seeded install whose
-- body already carries the new text, matches zero rows rather than rewriting
-- one with the value it already holds.
--
-- THE EMBEDDED TEXT IS A POINT-IN-TIME SNAPSHOT of two paragraphs of
-- PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY in packages/utils/lib/publishing-
-- planning-prompt.ts, as of this migration. A migration is frozen history and
-- can never be re-synced, so the copy is pinned from the other end instead:
-- packages/database/__tests__/migrations/sync-planning-analysis-linkedin.test.ts
-- reads these two dollar-quoted fragments straight out of this file and fails
-- if the constant stops matching them. A later reword of that paragraph turns
-- that test red, which is the moment to decide whether it needs a migration of
-- its own — it will, for the same reason this one exists.
--
-- Note this rewrites the version's content in place rather than adding a
-- version, so the change does not appear in the prompt's history in the UI. All
-- four `sync_*` predecessors do the same: adding a version here would leave the
-- SYSTEM binding pinned to the old one, and cascading it by hand is the
-- version-cascade the seed's own header calls unsafe in production.

-- migration-lint: allow unbatched-backfill — the `NOT EXISTS` guard reads as a
-- set-valued backfill to the linter, but the predicate is keyed to one SYSTEM
-- prompt key and its single default binding, so at most one prompt_version row
-- is ever matched or locked.
UPDATE "prompt_version" pv
SET content = replace(
	pv.content,
	$old_types$Recommend content types based on angle, audience, author fit and available
evidence. Supported types include Tweet / Short Post, Blog Post, Case Study,
Stakeholder Email, Webinar or Demo Script, Video Walkthrough Script, Newsletter
Blurb, and AI-assisted Video Walkthrough. For each relevant type, decide whether
it is recommended, possible but needing confirmation, or deferred and not
recommended yet.$old_types$,
	$new_types$Recommend content types based on angle, audience, author fit and available
evidence. Supported types include Tweet / Short Post, LinkedIn Post, Blog Post,
Case Study, Stakeholder Email, Webinar or Demo Script, Video Walkthrough Script,
Newsletter Blurb, and AI-assisted Video Walkthrough. For each relevant type,
decide whether it is recommended, possible but needing confirmation, or deferred
and not recommended yet.

Tweet / Short Post and LinkedIn Post are NOT interchangeable, and recommending
one is not implicitly recommending the other. A feed hides a LinkedIn post
after its first line or two behind "see more" and caps nothing; X caps hard and
hides nothing. So they suit different material: a point that needs a sentence
of setup before it lands can work on LinkedIn and cannot work as a tweet.
Where both fit, say so and say why each does.$new_types$
)
FROM "prompt_binding" b, "prompt" p
WHERE b."promptVersionId" = pv.id
  AND p.id = pv."promptId"
  AND p."scope" = 'SYSTEM'
  AND p."key" = 'publishing_topic_planning_analysis'
  AND b."targetType" = 'AGENT'
  AND b."targetKey" = 'publishing_topic_planning_analysis'
  AND b."documentType" = 'GENERAL'
  AND b."storyKind" IS NULL
  AND b."scope" = 'SYSTEM'
  AND b."isDefault" = true
  -- "LinkedIn" appears nowhere in the body this replaces, so this is only ever
  -- false on a body that has already been carried across.
  AND pv.content NOT LIKE '%LinkedIn Post%'
  AND NOT EXISTS (
    SELECT 1
    FROM "prompt_version" v2
    WHERE v2."promptId" = p.id
      AND v2."version" > 1
  );

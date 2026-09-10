-- Teach the deployed Topic Planning & Analysis prompt to tell a Webinar or Demo
-- Script apart from a Video Walkthrough Script (Fizzy #1988, Phase 2D slice 1).
--
-- WHY THIS MIGRATION EXISTS
-- `publishing_topic_planning_analysis` resolves at runtime through the SYSTEM
-- default AGENT binding onto a seeded PromptVersion, and seed-prompts-only.ts
-- is INSERT-ONLY for a SYSTEM prompt that already exists: editing
-- PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY reaches fresh installs and nothing
-- else. WEBINAR_SCRIPT is now a post type with its own tab, its own prompt and
-- its own generation workflow, but the analysis that recommends content types
-- is still working from a body that names "Webinar or Demo Script" beside
-- "Video Walkthrough Script" and says nothing about when either is the right
-- home for the material. This carries the paragraph that says so across.
-- Same shape as 20260909140000_sync_planning_analysis_linkedin_content_type,
-- which is the previous link in this prompt's chain.
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
-- whether they changed the paragraph below. The guard is the check, rather than
-- a record of one having been done against any particular environment.
--
-- The two guards below do DIFFERENT jobs and neither substitutes for the other.
-- `NOT EXISTS` is the customisation guard, and the only one: a customised body
-- that happens not to carry the new paragraph passes `NOT LIKE` untouched and
-- would be rewritten by `replace()` quite happily, so it is the version check
-- alone that declines it. `NOT LIKE`, with `replace()` behind it, is the
-- idempotency guard: a second apply, or an apply against a freshly-seeded
-- install whose body already carries the new text, matches zero rows rather
-- than rewriting one with the value it already holds.
--
-- WHY THE `NOT LIKE` STRING IS A CLAUSE AND NOT A TYPE NAME. The predecessor
-- guarded on '%LinkedIn Post%', which worked because the body it replaced had
-- never contained that phrase. Neither type name in THIS change can play that
-- role: "Webinar or Demo Script" and "Video Walkthrough Script" are both in the
-- supported-types sentence already, and have been since the prompt was first
-- seeded. A guard keyed on either is false on a stale row, so the migration
-- would record as applied while every deployed environment kept the old body
-- forever. The string below is instead a clause from the sentence this
-- migration adds, which is absent from the body before it runs and present
-- after — and it carries no `%` or `_`, so the SQL `LIKE` here and the
-- `String.includes` in the test that pins it mean the same thing.
--
-- WHY THE OLD FRAGMENT IS A REFLOW OF THE PREDECESSOR'S NEW ONE. Two rules
-- constrain the pair. The old text must not be a substring of the new text, or
-- `replace()` fires again on a body it has already rewritten; and it must lie
-- inside the previous migration's new text for this same agent key, or the
-- chain guard cannot replay the two substitutions in order. A purely additive
-- edit — a new paragraph appended after an untouched one — satisfies neither.
-- So the old fragment is the paragraph the LinkedIn migration wrote, and the
-- new fragment is that same paragraph reflowed to the file's line width with
-- the Webinar paragraph after it. Not one word of it changes; the reflow is
-- what makes the two fragments distinct.
--
-- THE EMBEDDED TEXT IS A POINT-IN-TIME SNAPSHOT of two paragraphs of
-- PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY in packages/utils/lib/publishing-
-- planning-prompt.ts, as of this migration. A migration is frozen history and
-- can never be re-synced, so the copy is pinned from the other end instead:
-- packages/database/__tests__/migrations/sync-prompt-migration-chains.test.ts
-- discovers every migration in this chain, replays the substitutions in
-- timestamp order, and fails if the constant stops agreeing with them. A later
-- reword of this paragraph turns that test red, which is the moment to decide
-- whether it needs a migration of its own — it will, for the same reason this
-- one exists.
--
-- Note this rewrites the version's content in place rather than adding a
-- version, so the change does not appear in the prompt's history in the UI.
-- Every `sync_*` predecessor does the same: adding a version here would leave
-- the SYSTEM binding pinned to the old one, and cascading it by hand is the
-- version-cascade the seed's own header calls unsafe in production.

-- migration-lint: allow unbatched-backfill — the `NOT EXISTS` guard reads as a
-- set-valued backfill to the linter, but the predicate is keyed to one SYSTEM
-- prompt key and its single default binding, so at most one prompt_version row
-- is ever matched or locked.
UPDATE "prompt_version" pv
SET content = replace(
	pv.content,
	$old_types$Tweet / Short Post and LinkedIn Post are NOT interchangeable, and recommending
one is not implicitly recommending the other. A feed hides a LinkedIn post
after its first line or two behind "see more" and caps nothing; X caps hard and
hides nothing. So they suit different material: a point that needs a sentence
of setup before it lands can work on LinkedIn and cannot work as a tweet.
Where both fit, say so and say why each does.$old_types$,
	$new_types$Tweet / Short Post and LinkedIn Post are NOT interchangeable, and recommending
one is not implicitly recommending the other. A feed hides a LinkedIn post after
its first line or two behind "see more" and caps nothing; X caps hard and hides
nothing. So they suit different material: a point that needs a sentence of setup
before it lands can work on LinkedIn and cannot work as a tweet. Where both fit,
say so and say why each does.

Webinar or Demo Script and Video Walkthrough Script are NOT interchangeable
either. A webinar or demo is performed live to people who can interrupt, so its
script needs a running order, a rough time for each beat, what is on screen
while it is spoken, and the questions the presenter should be ready for. A video
walkthrough is narration over a recording nobody can interrupt, so it can be
denser and shorter and needs none of that. Recommend a Webinar or Demo Script
when the material only lands with someone present to answer for it, and a Video
Walkthrough Script when it stands on its own.$new_types$
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
  -- A clause from the paragraph this migration adds. It appears nowhere in
  -- the body being replaced, so this is only ever false on a body that has
  -- already been carried across.
  AND pv.content NOT LIKE '%performed live to people who can interrupt%'
  AND NOT EXISTS (
    SELECT 1
    FROM "prompt_version" v2
    WHERE v2."promptId" = p.id
      AND v2."version" > 1
  );

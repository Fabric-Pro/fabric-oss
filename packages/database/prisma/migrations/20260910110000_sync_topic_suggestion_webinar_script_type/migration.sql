-- Teach the deployed Topic Suggestion prompt that Webinar / Demo Script is a
-- format it may recommend (Fizzy #1988, Phase 2D slice 1).
--
-- WHY THIS MIGRATION EXISTS, AND WHY IT MATTERS MORE THAN ITS PLANNING SIBLING
-- `publishing_topic_suggestion` resolves at runtime through the SYSTEM default
-- AGENT binding onto a seeded PromptVersion, and seed-prompts-only.ts is
-- INSERT-ONLY for a SYSTEM prompt that already exists: editing
-- PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY reaches fresh installs and nothing
-- else. This prompt names its post-type vocabulary as a closed set, so on a
-- deployed environment the daily suggestion cycle is still working from a set
-- of five that cannot contain the sixth type. The tab exists, the workflow
-- exists, and nothing ever recommends it.
--
-- The failure is silent in both directions, which is why this is a migration
-- and not a follow-up. A prompt that never names the type simply never emits
-- it. A prompt that names it with the WRONG LABEL is worse: the model spends
-- tokens on the recommendation and normalizeTopicEnrichment
-- (packages/database/src/publishing-suite-schema.ts) drops the row with a bare
-- `continue` because the string is not in POST_TYPE_LABELS. No throw, no log,
-- no counter, and the topic is created without it. So the label written below
-- is "Webinar / Demo Script" byte-for-byte, the whitelist's own spelling —
-- deliberately NOT the "Webinar or Demo Script" that the Planning & Analysis
-- prompt uses in the same slice, whose content-type list is free prose that
-- names nine types the six-value enum does not cover.
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
-- whether they changed the clause below. An organization that has retuned what
-- counts as newsworthy keeps its own wording and simply never recommends the
-- new type until it adds the label itself; overwriting their prompt to fix that
-- would be the worse trade.
--
-- The two guards below do DIFFERENT jobs and neither substitutes for the other.
-- `NOT EXISTS` is the customisation guard, and the only one: a customised body
-- that happens not to carry the new clause passes `NOT LIKE` untouched and
-- would be rewritten by `replace()` quite happily, so it is the version check
-- alone that declines it. `NOT LIKE`, with `replace()` behind it, is the
-- idempotency guard: a second apply, or an apply against a freshly-seeded
-- install whose body already carries the new text, matches zero rows rather
-- than rewriting one with the value it already holds.
--
-- WHY THE `NOT LIKE` STRING IS A CLAUSE AND NOT THE TYPE LABEL. Guarding on
-- '%Webinar / Demo Script%' would in fact work here — the label really is
-- absent from the body being replaced, and a migration is frozen, so it would
-- go on working. It is still the wrong instrument, and the reason is the
-- sibling migration landing in the same change. There the identical-looking
-- guard matches ZERO rows, because the planning prompt has named both of its
-- type names since it was first seeded. Two migrations for one change, one
-- keyed on a type label and one on a clause, would teach the next reader that
-- the label form is the ordinary one — and the next prompt whose vocabulary
-- already contains the word would get a migration that records as applied and
-- changes nothing. So both are keyed on a clause from the sentence being
-- added, which is unique to the migration that adds it. Neither carries a `%`
-- or a `_`, so the SQL `LIKE` here and the `String.includes` in the test that
-- pins it mean the same thing.
--
-- WHY THE PAIR STARTS AT THE ARRAY BOUND RATHER THAN AT THE TYPE SET. The old
-- text must not be a substring of the new text, or `replace()` fires again on a
-- body it has already rewritten. This prompt's whole output contract for
-- `postTypeRecommendations` is ONE ~1,600-character line, so the reflow that
-- separated the planning prompt's fragments is unavailable here. Instead the
-- fragment opens on the bound — "an array of 1 to 5 objects", which becomes
-- "1 to 6" — so the two differ at their first sentence and cannot nest. The
-- bound moves on its own merits as well: it is the size of the type set it
-- accompanies, and leaving it at five beside a set of six would forbid
-- recommending every type that fits. Six is still inside the schema's own
-- ceiling on the derived list, which reads `POST_TYPE_LABELS.length` rather
-- than a literal (packages/database/src/publishing-suite-schema.ts).
--
-- THE EMBEDDED TEXT IS A POINT-IN-TIME SNAPSHOT of one clause of
-- PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY in packages/utils/lib/publishing-
-- suggestion-prompt.ts, as of this migration. A migration is frozen history and
-- can never be re-synced, so the copy is pinned from the other end instead:
-- packages/database/__tests__/migrations/sync-prompt-migration-chains.test.ts
-- discovers every migration in this chain, replays the substitutions in
-- timestamp order, and fails if the constant stops agreeing with them. A later
-- reword of this clause turns that test red, which is the moment to decide
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
	$old_types$"postTypeRecommendations": an array of 1 to 5 objects, each { "type", "theme", "rationale" }, where "type" is chosen ONLY from this exact set — "Tweet", "LinkedIn Post", "Blog Post", "Case Study", "Stakeholder Email" — "theme" is a short angle/perspective (max 120 chars), and "rationale" is one sentence on why that format fits (max 240 chars). Judge fit from the topic's gravitas (a revolutionary, undeniable outcome warrants Case Study; a routine change suits a Tweet), theme (a hot take suits social; an in-depth analysis suits Blog Post or Case Study), and assets (a strong customer quote or outcome data in a transcript unlocks Case Study). "Tweet" and "LinkedIn Post" are NOT interchangeable and recommending one is not implicitly recommending the other: a LinkedIn feed hides everything after the first line or two behind "see more" and caps nothing, while X caps hard and hides nothing — so a point needing a sentence of setup before it lands works on LinkedIn and does not work as a tweet. Where both fit, emit both and say why each does. Do NOT emit any other "type" value; omit a row rather than inventing a format.$old_types$,
	$new_types$"postTypeRecommendations": an array of 1 to 6 objects, each { "type", "theme", "rationale" }, where "type" is chosen ONLY from this exact set — "Tweet", "LinkedIn Post", "Blog Post", "Case Study", "Stakeholder Email", "Webinar / Demo Script" — "theme" is a short angle/perspective (max 120 chars), and "rationale" is one sentence on why that format fits (max 240 chars). Judge fit from the topic's gravitas (a revolutionary, undeniable outcome warrants Case Study; a routine change suits a Tweet), theme (a hot take suits social; an in-depth analysis suits Blog Post or Case Study), and assets (a strong customer quote or outcome data in a transcript unlocks Case Study). "Tweet" and "LinkedIn Post" are NOT interchangeable and recommending one is not implicitly recommending the other: a LinkedIn feed hides everything after the first line or two behind "see more" and caps nothing, while X caps hard and hides nothing — so a point needing a sentence of setup before it lands works on LinkedIn and does not work as a tweet. Where both fit, emit both and say why each does. "Webinar / Demo Script" is not a written piece at all: it is a running order for a live session someone presents and is present to answer for — beats, rough timings, what is on screen, and the questions to expect. Recommend it when the topic has something to SHOW and an audience worth assembling for it, not because the subject is merely substantial; a substantial subject with nothing to demonstrate is a Blog Post or a Case Study. Do NOT emit any other "type" value; omit a row rather than inventing a format.$new_types$
)
FROM "prompt_binding" b, "prompt" p
WHERE b."promptVersionId" = pv.id
  AND p.id = pv."promptId"
  AND p."scope" = 'SYSTEM'
  AND p."key" = 'publishing_topic_suggestion'
  AND b."targetType" = 'AGENT'
  AND b."targetKey" = 'publishing_topic_suggestion'
  AND b."documentType" = 'GENERAL'
  AND b."storyKind" IS NULL
  AND b."scope" = 'SYSTEM'
  AND b."isDefault" = true
  -- A clause from the sentence this migration adds. It appears nowhere in
  -- the body being replaced, so this is only ever false on a body that has
  -- already been carried across.
  AND pv.content NOT LIKE '%a running order for a live session%'
  AND NOT EXISTS (
    SELECT 1
    FROM "prompt_version" v2
    WHERE v2."promptId" = p.id
      AND v2."version" > 1
  );

-- A suggested time entry must not claim more than the member's activity
-- shows: that a meeting was attended, or that work was completed, merged,
-- shipped or fixed. The source in `@repo/utils/time-suggestion-prompt`
-- (TIME_SUGGESTION_FALLBACK_BODY) now says so, but the seed never rewrites
-- an existing SYSTEM prompt, so environments seeded with the earlier version
-- need this patch.
--
-- Idempotent: the LIKE filters only match rows that still hold the old rule
-- and do not hold the new one yet. Only the SYSTEM-scoped prompt changes;
-- org and user copies are left alone.

UPDATE "prompt_version" pv
SET content = REPLACE(
  pv.content,
  'Do not invent work the evidence does not show, and do not state a duration.',
  'Do not invent work the evidence does not show, and do not state a duration. Describe what the evidence shows was worked on. Never say that a meeting was attended, that work was completed, merged, shipped or fixed, or state any other outcome, unless the evidence itself says so.'
)
FROM "prompt" p
WHERE pv."promptId" = p.id
  AND p.key = 'time_suggestion_drafter'
  AND p.scope = 'SYSTEM'
  AND pv.content LIKE '%Do not invent work the evidence does not show, and do not state a duration.%'
  AND pv.content NOT LIKE '%Never say that a meeting was attended%';

-- ROLLBACK (manual, only if needed): apply the inverse REPLACE to the same
-- rows.

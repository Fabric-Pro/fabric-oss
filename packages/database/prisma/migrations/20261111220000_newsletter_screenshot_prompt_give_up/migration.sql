-- The release-notes screenshot prompt told the model to capture the closest
-- screen when the one the brief names could not be reached, so a capture
-- could save a sign-in page as a release-notes picture. The source in
-- `seed-prompts-only.ts` now offers a `give_up` decision instead, but the seed
-- never rewrites an existing SYSTEM prompt, so environments seeded with the
-- first version need this patch.
--
-- Idempotent: the LIKE filters skip rows that no longer hold the old text.
-- Only the SYSTEM-scoped prompt changes; org and user copies are left alone.

UPDATE "prompt_version" pv
SET content = REPLACE(
  REPLACE(
    pv.content,
    '- capture — take the picture now. Optionally give "role" and "name" of one element from the snapshot to capture only that element; leave them out to capture the whole visible page.',
    '- capture — take the picture now. Optionally give "role" and "name" of one element from the snapshot to capture only that element; leave them out to capture the whole visible page.
- give_up — stop without a picture. Say in "reasoning" what you found instead.'
  ),
  '- If the change cannot be reached from this page, capture the closest screen rather than wandering.',
  '- If the screen the brief names cannot be reached, or the page shows a sign-in form, an error or an empty state instead, give_up. A wrong picture is worse than none.'
)
FROM "prompt" p
WHERE pv."promptId" = p.id
  AND p.key = 'newsletter_screenshot_capture'
  AND p.scope = 'SYSTEM'
  AND pv.content LIKE '%capture the closest screen rather than wandering%';

-- ROLLBACK (manual, only if needed): apply the inverse REPLACE of both
-- substrings to the same rows.

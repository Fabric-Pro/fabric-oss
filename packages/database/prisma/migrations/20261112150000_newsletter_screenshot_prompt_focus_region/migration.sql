-- The release-notes email shows a screenshot about 450 px wide. A capture of
-- a whole desktop page shrinks there until its text is hard to read, yet the
-- screenshot prompt left the choice between an element and the page open.
-- The source in `seed-prompts-only.ts` now asks for the panel, dialog, table
-- or section that shows the change, but the seed never rewrites an existing
-- SYSTEM prompt, so environments seeded with an earlier version need this
-- patch.
--
-- Idempotent: the LIKE filter only matches rows that still hold the old rule.
-- Only the SYSTEM-scoped prompt changes; org and user copies are left alone.

UPDATE "prompt_version" pv
SET content = REPLACE(
  pv.content,
  '- For a small change, capture the element that changed. For a large change, capture the page that shows it best.',
  '- The email shows the picture about 450 px wide, so a whole page shrinks until its text is hard to read. Capture the panel, dialog, table or section that shows the change by giving its role and name. Capture the whole visible page only when the change spans it.'
)
FROM "prompt" p
WHERE pv."promptId" = p.id
  AND p.key = 'newsletter_screenshot_capture'
  AND p.scope = 'SYSTEM'
  AND pv.content LIKE '%For a small change, capture the element that changed.%';

-- ROLLBACK (manual, only if needed): apply the inverse REPLACE to the same
-- rows.

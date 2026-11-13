-- The release-notes screenshot prompt forbids administration and settings
-- screens, yet its operation examples named a "Settings" button and a
-- `/settings` path. The source in `seed-prompts-only.ts` now uses a "Filters"
-- button and a `/projects` path, but the seed never rewrites an existing
-- SYSTEM prompt, so environments seeded with an earlier version need this
-- patch.
--
-- Idempotent: each statement only touches rows that still hold its old
-- example. Only the SYSTEM-scoped prompt changes; org and user copies are
-- left alone.

UPDATE "prompt_version" pv
SET content = REPLACE(
  pv.content,
  '- click — needs "role" and "name", copied verbatim from the snapshot (e.g. role "button", name "Settings")',
  '- click — needs "role" and "name", copied verbatim from the snapshot (e.g. role "button", name "Filters")'
)
FROM "prompt" p
WHERE pv."promptId" = p.id
  AND p.key = 'newsletter_screenshot_capture'
  AND p.scope = 'SYSTEM'
  AND pv.content LIKE '%(e.g. role "button", name "Settings")%';

UPDATE "prompt_version" pv
SET content = REPLACE(
  pv.content,
  '- goto — needs "path", relative to the site (e.g. "/settings"). Never a full URL to another site.',
  '- goto — needs "path", relative to the site (e.g. "/projects"). Never a full URL to another site.'
)
FROM "prompt" p
WHERE pv."promptId" = p.id
  AND p.key = 'newsletter_screenshot_capture'
  AND p.scope = 'SYSTEM'
  AND pv.content LIKE '%relative to the site (e.g. "/settings")%';

-- ROLLBACK (manual, only if needed): apply the inverse REPLACE of both
-- example lines to the same rows.

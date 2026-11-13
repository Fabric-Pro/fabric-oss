-- The release-notes screenshot prompt forbade confirming a form, but not
-- opening the screens where people, billing and settings are managed. The
-- source in `seed-prompts-only.ts` now keeps the browser out of those screens
-- and away from anything that changes data, but the seed never rewrites an
-- existing SYSTEM prompt, so environments seeded with an earlier version need
-- this patch.
--
-- Idempotent: the LIKE filter needs the line the rule is added after, and the
-- NOT LIKE filter skips rows that already carry the rule. Only the
-- SYSTEM-scoped prompt changes; org and user copies are left alone.

UPDATE "prompt_version" pv
SET content = REPLACE(
  pv.content,
  '- Never submit a form, save, delete, send, invite or pay. Opening a dialog is fine; confirming it is not.',
  '- Never submit a form, save, delete, send, invite or pay. Opening a dialog is fine; confirming it is not.
- Never open administration, settings, billing, member or user-management screens, and never click anything that deletes, saves, submits, invites, sends or changes data. If the brief needs one of those, give_up.'
)
FROM "prompt" p
WHERE pv."promptId" = p.id
  AND p.key = 'newsletter_screenshot_capture'
  AND p.scope = 'SYSTEM'
  AND pv.content LIKE '%Opening a dialog is fine; confirming it is not.%'
  AND pv.content NOT LIKE '%Never open administration, settings, billing%';

-- ROLLBACK (manual, only if needed): REPLACE the added line (with its leading
-- newline) by an empty string in the same rows.

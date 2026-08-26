-- Retire "User Story" terminology from document-generation prompts.
--
-- Already-seeded environments (staging/prod) hold the previous prompt content
-- for the feature/story document-generation prompts. The seed scripts are
-- insert-only, so this migration rewrites the seeded content in place so those
-- environments stop emitting US-XXX identifiers, STORY_START/STORY_END
-- delimiters, and "User Story" terminology. Fresh installs produce the same
-- result from the updated seed files (seed.ts / seed-prompts-only.ts).
--
-- Scope:
--   * Rows: every "prompt_version" whose parent "prompt".key is one of the
--     document-generation feature/story keys. ALL versions are rewritten (not
--     just the latest) so that no bound version — latest or historical — can
--     still emit the retired terminology, regardless of which version a
--     prompt_binding points at.
--   * "user_stories_template" (legacy seed.ts key) and "user_story_template"
--     (seed-prompts-only.ts / v2 key) both hold the same prompt family and are
--     both targeted by the existing migrate-user-story-template-v2 script, so
--     both are included alongside "story_breakdown_template".
--
-- Token transforms (applied in order; matches the edits made to the seed files):
--   1. US-<digit>      -> F-<digit>          (regexp, global)  e.g. US-001 -> F-001
--   2. US-[NUMBER]     -> F-[NUMBER]         (placeholder used by story_breakdown_template)
--   3. STORY_START     -> FEATURE_START
--   4. STORY_END       -> FEATURE_END
--   5. "User Story hierarchy" -> "Feature hierarchy"  (inline hierarchy phrasing)
--   6. "User Story"    -> "Description"       (remaining occurrences are the leaf section heading)
--   7. "User Stories"  -> "Features"
--   8. "user stories"  -> "features"
--   9. "user story"    -> "feature"
--
-- The transforms are idempotent: a second run finds no remaining source tokens.

UPDATE "prompt_version" AS pv
SET content =
	replace(
		replace(
			replace(
				replace(
					replace(
						replace(
							replace(
								replace(
									regexp_replace(pv.content, 'US-([0-9])', 'F-\1', 'g'),
									'US-[NUMBER]', 'F-[NUMBER]'
								),
								'STORY_START', 'FEATURE_START'
							),
							'STORY_END', 'FEATURE_END'
						),
						'User Story hierarchy', 'Feature hierarchy'
					),
					'User Story', 'Description'
				),
				'User Stories', 'Features'
			),
			'user stories', 'features'
		),
		'user story', 'feature'
	)
FROM "prompt" AS p
WHERE pv."promptId" = p.id
	AND p.key IN (
		'user_story_template',
		'user_stories_template',
		'story_breakdown_template'
	);

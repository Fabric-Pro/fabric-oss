import { z } from "zod";

/**
 * Project-tab customization config — the shared contract for Fizzy card #1837
 * (per-project tab visibility set by admins, per-user visibility/ordering).
 *
 * Persisted as two nullable Json columns (no new table):
 *   - `Project.projectTabConfig`        → `ProjectTabConfig`  (admin level)
 *   - `ProjectUserPreference.projectTabPrefs` → `ProjectTabPrefs` (user level)
 *
 * This module is imported by BOTH the oRPC API (`packages/api`) and the web
 * client (`apps/web`) — both already depend on `@repo/database`, so hosting it
 * here avoids a circular cross-package import (same reasoning as
 * field-mapping-schema.ts). The canonical LIST of tab ids lives in
 * `apps/web/.../ProjectDetails.tsx` (the drift test parses its source), so
 * these schemas validate SHAPE only; unknown ids are ignored by the client's
 * resolver rather than rejected here, so adding a tab never needs an API or
 * database change.
 */

/**
 * Tabs no one can hide: `overview` is every project's landing page and
 * `settings` is where a hidden tab gets turned back on. Enforced server-side
 * on write (the API rejects an override for these ids) and again at read time
 * in the web resolver.
 */
export const PROJECT_TAB_PROTECTED_IDS = ["overview", "settings"] as const;

export function isProtectedProjectTab(tabId: string): boolean {
	return (PROJECT_TAB_PROTECTED_IDS as readonly string[]).includes(tabId);
}

/** Admin-level per-tab visibility overrides: `{ tabId: isVisible }`. */
const tabOverrideMapSchema = z.record(z.string().min(1).max(40), z.boolean());

/**
 * Stored in `Project.projectTabConfig`. A wrapper object so a future key
 * (e.g. an admin default order) can join by extending this schema, without
 * changing the column's meaning. Absent/null → every tab this deployment
 * offers is visible. Deliberately strict (no passthrough): the inferred type must
 * stay assignable to Prisma's InputJsonValue for the write path.
 */
export const projectTabConfigSchema = z
	.object({
		overrides: tabOverrideMapSchema.optional(),
	})
	// The overrides map ships to every viewer of the project on each page
	// load, so bound its size too — per-key caps alone let one PATCH store an
	// arbitrarily large payload.
	.refine(
		(config) => Object.keys(config.overrides ?? {}).length <= 40,
		"At most 40 tab overrides",
	);

export type ProjectTabConfig = z.infer<typeof projectTabConfigSchema>;

/** User-level personalization: which permitted tabs to hide, and their order. */
export const projectTabPrefsSchema = z.object({
	hidden: z.array(z.string().min(1).max(40)).max(40).optional(),
	order: z.array(z.string().min(1).max(40)).max(60).optional(),
});

export type ProjectTabPrefs = z.infer<typeof projectTabPrefsSchema>;

/**
 * Tolerant read-side normalizer for whatever is in the Json column — a parse
 * failure just means "no config saved". Unknown tab ids are NOT filtered here
 * (only the web client knows the live list); they are ignored downstream.
 */
export function normalizeProjectTabConfig(
	value: unknown,
): ProjectTabConfig | null {
	const parsed = projectTabConfigSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Same tolerant normalization for the per-user prefs column. */
export function normalizeProjectTabPrefs(
	value: unknown,
): ProjectTabPrefs | null {
	const parsed = projectTabPrefsSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

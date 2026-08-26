import type { SettingsTab } from "./ProjectSettingsNav";

// Every known settings-tab id. Used by the storage-migration read path to reject
// stale/unknown persisted values (e.g. the pre-rename `"execution"` string).
export const KNOWN_SETTINGS_TABS: readonly SettingsTab[] = [
	"general",
	"knowledge",
	"development",
	"project-management",
	"members",
	"retrieval",
	"environments",
	"testing",
	"newsletter",
	"publishing",
	"danger",
];

/** Which flag-gated sub-tabs the current viewer may actually land on. */
export type SettingsTabGates = {
	pmFieldMappingEnabled: boolean;
	/** `NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES` — gates Environments and Testing. */
	qaEnabled: boolean;
	/** `NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE` — gates Publishing Suite. */
	publishingEnabled: boolean;
};

/**
 * Resolve a persisted sub-tab value from sessionStorage into a valid `SettingsTab`.
 * Gracefully migrates old/unknown values — notably the pre-rename `"execution"` —
 * to `"development"` rather than leaving an invalid tab selected. Returns `null`
 * when nothing is persisted so the caller can fall back to the default tab.
 *
 * Gates arrive as a named object rather than positional booleans: two adjacent
 * `boolean` parameters accept each other silently, and getting them the wrong way
 * round would strand someone on a hidden tab with no visible cause.
 *
 * Kept in its own module (with only a type-only import) so it can be unit-tested
 * without evaluating the `"use client"` `ProjectSettings` module graph.
 */
export function resolveStoredSettingsTab(
	stored: string | null,
	gates: SettingsTabGates,
): SettingsTab | null {
	if (!stored) {
		return null;
	}
	if ((KNOWN_SETTINGS_TABS as readonly string[]).includes(stored)) {
		// Never land on the flag-gated PM tab when the flag is off.
		if (stored === "project-management" && !gates.pmFieldMappingEnabled) {
			return "development";
		}
		// Same for the QA pair. Both render a full configuration surface for a
		// page the flag hides and an API that refuses the caller server-side, so
		// a stale sessionStorage value must not reopen them.
		if (
			(stored === "environments" || stored === "testing") &&
			!gates.qaEnabled
		) {
			return "development";
		}
		// Same for Publishing Suite — the settings sub-tab configures a page
		// the flag hides, so a stale sessionStorage value must not reopen it.
		if (stored === "publishing" && !gates.publishingEnabled) {
			return "development";
		}
		return stored as SettingsTab;
	}
	// Stale/unknown persisted value (incl. the renamed `"execution"`) → Development.
	return "development";
}

import type { LastEditSource } from "@repo/database";

/**
 * Display copy for a UserStory's last-edit provenance, shown as the Fabric-side
 * "source" element in the PM-sync conflict dialog. Inline strings (no i18n) to
 * match the existing inline metadata copy in `ConflictResolveDialog.tsx`; tone
 * per `fabric/standards/ai/ai-copy-tone.md` (plain, factual).
 *
 * `PM_PULL` interpolates the connected PM tool label (resolved by the caller via
 * `formatPmToolLabel`), falling back to a generic "PM tool".
 */
const STATIC_LAST_EDIT_SOURCE_LABELS: Record<
	Exclude<LastEditSource, "PM_PULL">,
	string
> = {
	MANUAL: "Manual edit",
	AI_BACKLOG_UPDATE: "AI backlog update",
	AI_MATURATION: "AI maturation",
	CONFLICT_RESOLUTION: "Conflict resolution",
};

export function formatLastEditSource(
	source: LastEditSource | null | undefined,
	pmToolLabel: string | null,
): string {
	if (!source) {
		// Pre-feature rows (never edited since this shipped) carry no source.
		return "Source unavailable";
	}
	if (source === "PM_PULL") {
		return `Pulled from ${pmToolLabel ?? "PM tool"}`;
	}
	return STATIC_LAST_EDIT_SOURCE_LABELS[source];
}

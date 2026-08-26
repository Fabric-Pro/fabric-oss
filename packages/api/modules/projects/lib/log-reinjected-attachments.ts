/**
 * Shared `logger.warn` emitter for the in-body attachment auto-reinject
 * guard. The four persistence sites that run the guard —
 * `update-drafting-stage-with-version`, `enhance-feature`,
 * `update-with-context`, and `reevaluate-bug` — all need to emit the same
 * structured log line whenever they reinject a dropped `story-media/` key.
 *
 * The string prefix `[stage-transition]` is preserved across all four
 * sites for grep simplicity; the `surface`
 * discriminant on the structured payload disambiguates which call site
 * fired. Centralising the call shape here guarantees the §10.1 field
 * schema (`storyId`, `projectId`, `surface`, `targetStage`,
 * `droppedKeyCount`, `droppedKeys`, `draftingStage`) cannot drift across
 * the four sites as the guards evolve independently.
 *
 * Out of scope (per spec §10.3): no counters, no dashboards, no alerts.
 * This helper emits the structured `warn` only; downstream observability
 * indexes the field schema and surfaces drop spikes from there.
 *
 * Inline `logger.error` lines at the call sites (prefix-mismatch /
 * sign-failure recovery) intentionally stay inline — they are scoped
 * local failure modes the shared helper does not subsume.
 */

import type { FeatureDraftingStage } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * Discriminant tag identifying which guard site emitted the log line.
 * Matches the `surface` enum in spec §10.1.
 */
export type ReinjectedAttachmentsSurface =
	| "stage-transition"
	| "update-with-context"
	| "reevaluate-bug"
	| "enhance-feature";

/**
 * Emit the `[stage-transition] reinjected dropped attachments` structured
 * `warn` log per spec §10.1. `droppedKeyCount` is computed from
 * `droppedKeys.length` inside the helper so the caller cannot let the
 * count and the array diverge.
 */
export function logReinjectedAttachments(params: {
	storyId: string;
	projectId: string;
	surface: ReinjectedAttachmentsSurface;
	targetStage: FeatureDraftingStage | null;
	draftingStage: FeatureDraftingStage | null;
	droppedKeys: string[];
}): void {
	const {
		storyId,
		projectId,
		surface,
		targetStage,
		draftingStage,
		droppedKeys,
	} = params;

	logger.warn("[stage-transition] reinjected dropped attachments", {
		storyId,
		projectId,
		surface,
		targetStage,
		droppedKeyCount: droppedKeys.length,
		droppedKeys,
		draftingStage,
	});
}

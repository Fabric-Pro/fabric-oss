/**
 * Seam for 3B and 3C (Fizzy #2208, #2211): the items in the Roadmap's "More
 * Roadmap actions" menu.
 *
 * Each slice adds ONE hook call here returning `{ item | null, overlay }`, and
 * appends its item and overlay. The Roadmap renders `items` in
 * `RoadmapActionsMenu` and `overlays` once, so a slice's dialog lives beside
 * its menu item without the page knowing it exists.
 */

import type { LucideIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { GateLink } from "../../capability-gates/gate-destinations";
import { useRecommendActionItem } from "../recommendations/useRecommendActionItem";
import { useRemoveAiRecommendedAction } from "../useRemoveAiRecommendedAction";
import type { RoadmapBlock } from "./entry-point-states";
import type { RoadmapRecommendationStarter } from "./recommendation-starter";

export interface RoadmapActionItem {
	id: string;
	label: string;
	icon: LucideIcon;
	onSelect: () => void;
	/**
	 * Shown under the label; the item is disabled when this is set. Disabled
	 * means `aria-disabled`, so the reason stays reachable by keyboard.
	 */
	disabledReason: string | null;
	/** A second line under `disabledReason`, e.g. a gate's body (FR37). */
	disabledDetail?: string | null;
	/** What the item does, under its label (FR10). */
	description?: string | null;
	/** A caution that never blocks the item (a WARNING gate, FR56/FR59). */
	warning?: string | null;
	/** The fix for a disabled item, rendered as its own menu item. */
	remedy?: ({ label: string } & GateLink) | null;
}

interface RoadmapActionItemsArgs {
	projectId: string;
	organizationId: string | null;
	roadmapPopulated: boolean;
	/** `project.roadmap` from `projects.get`; undefined while it loads. */
	roadmap: RoadmapBlock | undefined;
	/** The page's one recommendation starter, shared with the empty state. */
	recommendationStarter: RoadmapRecommendationStarter | null;
	/** `project.canUpdateProject`; undefined while it loads. */
	canUpdateProject: boolean | undefined;
}

export function useRoadmapActionItems(args: RoadmapActionItemsArgs): {
	items: RoadmapActionItem[];
	overlays: ReactNode;
} {
	const recommendItem = useRecommendActionItem({
		starter: args.recommendationStarter,
		canUpdateProject: args.canUpdateProject,
	});
	const removeAi = useRemoveAiRecommendedAction({
		projectId: args.projectId,
		roadmap: args.roadmap,
	});

	// The mature-Roadmap entry (FR28). An unpopulated Roadmap already offers
	// Recommend on its Start Building card, which sends EMPTY_ROADMAP.
	const matureRecommendItem = args.roadmapPopulated ? recommendItem : null;

	const items = useMemo(
		() =>
			[matureRecommendItem, removeAi.item].filter(
				(item): item is RoadmapActionItem => item !== null,
			),
		[matureRecommendItem, removeAi.item],
	);

	return { items, overlays: <>{removeAi.overlay}</> };
}

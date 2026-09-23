/**
 * Seam for 3B (Fizzy #2208): starts a Roadmap recommendation run.
 *
 * 3A's entry points — the empty state's Recommend and Do both — call this and
 * nothing else, so the recommendation flow can land without either side
 * editing the other. `null` means no starter exists (the flag is off or no AI
 * provider resolves), and every entry point that needs one stays hidden.
 *
 * The Roadmap calls this ONCE and hands the result to its actions menu too, so
 * every entry point shares one run: one poll, one outcome toast, one "already
 * running" answer.
 */

import { useMemo } from "react";
import { useRecommendationRun } from "../recommendations/useRecommendationRun";
import type { RoadmapBlock } from "./entry-point-states";

export type RecommendationEntryPoint =
	| "EMPTY_ROADMAP"
	| "MATURE_ROADMAP"
	| "DO_BOTH_AFTER_PULL";

export interface RoadmapRecommendationStarter {
	/** Rejects with a user-facing message; never toasts a failure itself. */
	start(req: {
		entryPoint: RecommendationEntryPoint;
		/** The pull Do both ran first, so the run can read what it imported. */
		precedingPullWorkflowId?: string;
	}): Promise<void>;
	isStarting: boolean;
	/** A run is in flight, whoever started it. */
	isRunning: boolean;
}

interface RecommendationStarterArgs {
	projectId: string;
	/** `project.roadmap` from `projects.get`; undefined while it loads. */
	roadmap: RoadmapBlock | undefined;
}

export function useRoadmapRecommendationStarter({
	projectId,
	roadmap,
}: RecommendationStarterArgs): RoadmapRecommendationStarter | null {
	const available =
		roadmap?.recommendationsEnabled === true && roadmap.providerAvailable;
	const { start, isStarting, isRunning } = useRecommendationRun({
		projectId,
		enabled: available,
	});

	return useMemo(
		() =>
			available
				? {
						// The run reads the Roadmap as it stands when it starts,
						// so the preceding pull needs no forwarding.
						start: ({ entryPoint }) => start(entryPoint),
						isStarting,
						isRunning,
					}
				: null,
		[available, start, isStarting, isRunning],
	);
}

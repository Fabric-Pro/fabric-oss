"use client";

/**
 * Readiness snapshot for a feature (plan §1.1 / Slice 5).
 *
 * Keyed by story id + version so any content or stage change refetches.
 * Shared by the readiness panel, StartWorkButton and the transition dialog.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import type { StoryReadiness } from "../../lib/stories/readiness";

const STORY_READINESS_QUERY_KEY = "story-readiness" as const;

function storyReadinessQueryKey(params: {
	projectId: string;
	storyId: string;
	organizationId?: string | null;
	version?: number | null;
}) {
	return [
		STORY_READINESS_QUERY_KEY,
		params.projectId,
		params.storyId,
		params.organizationId ?? null,
		params.version ?? null,
	] as const;
}

/** Invalidate every readiness snapshot for a story regardless of version. */
export function invalidateStoryReadiness(
	queryClient: QueryClient,
	params: { projectId: string; storyId: string },
) {
	return queryClient.invalidateQueries({
		queryKey: [STORY_READINESS_QUERY_KEY, params.projectId, params.storyId],
	});
}

export function useStoryReadiness(params: {
	projectId: string;
	storyId: string;
	organizationId?: string | null;
	version?: number | null;
	enabled?: boolean;
}) {
	const {
		projectId,
		storyId,
		organizationId,
		version,
		enabled = true,
	} = params;
	return useQuery<StoryReadiness>({
		queryKey: storyReadinessQueryKey({
			projectId,
			storyId,
			organizationId,
			version,
		}),
		queryFn: async () =>
			(await orpcClient.projects.stories.readiness({
				projectId,
				storyId,
				organizationId: organizationId ?? null,
			})) as StoryReadiness,
		enabled: enabled && !!projectId && !!storyId,
		staleTime: 15_000,
	});
}

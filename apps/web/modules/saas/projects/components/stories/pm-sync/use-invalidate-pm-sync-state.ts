"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

/**
 * Shared post-action cache invalidation for EVERY PM-sync resolve surface
 * (roadmap StoryCard conflict dialog, Review Center row actions, editor
 * PmSyncChip). One source of truth for the query families that render
 * PM-sync state, so no surface can go stale when another one acts:
 *
 *  - projects.stories.list        → roadmap card pill + cloud-icon overlay
 *  - projects.stories.get         → editor copy of the story
 *  - projects.reviewCenter.items  → Review Center grouped list
 *  - projects.reviewCenter.count  → Review Center toolbar badge
 *
 * KEY SHAPE — read before "simplifying":
 * oRPC query keys are NESTED: `[["projects","stories","list"], { input, type }]`
 * (the first element is the path ARRAY). A hand-built flat filter like
 * `["projects", "stories"]` positionally compares a string against that path
 * array and silently matches NOTHING — that exact bug shipped as a stale
 * conflict pill. Always derive filters from `orpc.*.key()` / `.queryKey()`.
 *
 * This helper uses PROJECT-SCOPED PARTIAL keys (`.key({ input: { projectId } })`
 * → `[path, { input: { projectId } }]`). TanStack's partialMatchKey does a
 * recursive subset comparison, so the filter matches every registered query
 * whose input contains this projectId — regardless of whether the subscriber
 * serialized `organizationId` as a string, `null`, or omitted it (`undefined`).
 * That neutralizes the null-vs-undefined key-divergence class (StoriesRoadmap
 * subscribes with context `string | null`; StoryCard props allow `undefined`).
 * Tenant safety: a projectId never spans tenants (XOR isolation), so a
 * project-scoped filter cannot refetch another tenant's data.
 */
export function useInvalidatePmSyncState(
	projectId: string,
): () => Promise<void> {
	const queryClient = useQueryClient();

	return useCallback(async () => {
		await Promise.all(
			[
				orpc.projects.stories.list.key({ input: { projectId } }),
				orpc.projects.stories.get.key({ input: { projectId } }),
				orpc.projects.reviewCenter.items.key({ input: { projectId } }),
				orpc.projects.reviewCenter.count.key({ input: { projectId } }),
			].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
		);
	}, [queryClient, projectId]);
}

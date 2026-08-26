"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { FeatureOption } from "./feature-options";

/**
 * Resolves a work-item id a caller already holds — a filter chip's stored value
 * — back to its identifier and title for display.
 *
 * Reads `stories.list`, which the roadmap views already load, so the lookup
 * shares their react-query cache entry instead of fetching its own copy.
 * `enabled` keeps that fetch off until there is actually an id to resolve.
 *
 * NOT the picker's option source: the picker lists and ranks server-side
 * (`testCases.featureCoverage`) because a project can hold more work items than
 * one page of this query returns.
 */
export function useFeatureOptions(args: {
	projectId: string;
	organizationId: string | null;
	enabled: boolean;
}) {
	const { data, isLoading } = useQuery({
		...orpc.projects.stories.list.queryOptions({
			input: {
				projectId: args.projectId,
				organizationId: args.organizationId,
			},
		}),
		enabled: args.enabled,
		staleTime: 60_000,
	});

	return useMemo(() => {
		const options: FeatureOption[] = (data?.stories ?? []).map((story) => ({
			id: story.id,
			identifier: story.identifier,
			title: story.title,
			kind: story.kind,
		}));
		return {
			byId: new Map(options.map((option) => [option.id, option])),
			isLoading,
		};
	}, [data?.stories, isLoading]);
}

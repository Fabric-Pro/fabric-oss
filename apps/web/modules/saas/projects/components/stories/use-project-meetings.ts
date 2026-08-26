"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

/**
 * Shared data hook for the AI Updates meetings source dropdown.
 *
 * Wraps the `projects.backlog.listMeetings` procedure in TanStack Query so that:
 *  - repeated opens within the same session are served from cache (no refetch),
 *  - the per-`daysBack` result is cached independently, and
 *  - `refresh()` force-bypasses both the client cache and the server cache.
 *
 * The underlying procedure calls Microsoft Graph; a per-user 60s server cache
 * makes cold opens fast too. This hook only fetches the meeting *list* — it does
 * not touch how transcripts are later resolved for the AI analysis.
 */

export const MEETINGS_STALE_TIME = 5 * 60 * 1000; // 5 minutes

export type ProjectMeeting = {
	id: string;
	subject: string;
	startTime: string | null;
	organizer: string;
	joinUrl: string;
};

type RawMeeting = {
	id: string;
	subject: string;
	startTime?: string | null;
	organizer: string;
	joinUrl?: string | null;
};

function mapMeetings(raw: readonly RawMeeting[] | undefined): ProjectMeeting[] {
	return (raw ?? [])
		.filter((m): m is RawMeeting & { joinUrl: string } => !!m.joinUrl)
		.map((m) => ({
			id: m.id,
			subject: m.subject,
			startTime: m.startTime ?? null,
			organizer: m.organizer,
			joinUrl: m.joinUrl,
		}));
}

export function useProjectMeetings({
	projectId,
	organizationId,
	daysBack,
}: {
	projectId: string;
	organizationId: string | null;
	daysBack: number;
}) {
	const queryClient = useQueryClient();
	const [isRefreshing, setIsRefreshing] = useState(false);

	const queryOptions = orpc.projects.backlog.listMeetings.queryOptions({
		input: { projectId, organizationId, daysBack },
	});

	const query = useQuery({
		...queryOptions,
		staleTime: MEETINGS_STALE_TIME,
	});

	const meetings = useMemo(
		() => mapMeetings(query.data?.meetings),
		[query.data],
	);

	// Force a fresh fetch that bypasses both the client cache and the 60s server
	// cache (forceRefresh), then write the result back into the query cache so the
	// UI updates and the new value is reused by subsequent opens.
	const refresh = useCallback(async () => {
		setIsRefreshing(true);
		try {
			const fresh = await orpcClient.projects.backlog.listMeetings({
				projectId,
				organizationId,
				daysBack,
				forceRefresh: true,
			});
			queryClient.setQueryData(queryOptions.queryKey, fresh);
		} catch {
			// A forced refresh failed (e.g. a transient Microsoft Graph error).
			// Fall back to a normal refetch so the query's own error/loading
			// state drives the UI instead of leaving an unhandled rejection.
			queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
		} finally {
			setIsRefreshing(false);
		}
	}, [
		projectId,
		organizationId,
		daysBack,
		queryClient,
		queryOptions.queryKey,
	]);

	return {
		meetings,
		isLoading: query.isLoading,
		isFetching: query.isFetching || isRefreshing,
		isError: query.isError,
		error: query.error as Error | null,
		refresh,
	};
}

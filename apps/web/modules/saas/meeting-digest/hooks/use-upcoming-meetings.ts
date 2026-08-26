"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { mergeUpcomingChunks } from "../lib/group-upcoming";

/** Mirrors the server's `UpcomingAgendaStatus`. */
export type AgendaStatus = "READY" | "GENERATING" | "FAILED";

export interface UpcomingMeeting {
	joinUrl: string;
	subject: string;
	startTime: string;
	organizer: string;
	linkedMeetingId: string | null;
	/**
	 * null means "linked, no agenda yet". An UNLINKED meeting is also null, but
	 * the UI reads that case off `linkedMeetingId` — no agenda can exist for it,
	 * which is a different claim from "not generated yet".
	 */
	agendaStatus: AgendaStatus | null;
}

/**
 * Today and tomorrow. Two days of one calendar almost always fit inside a single
 * Graph page, so first paint costs one round trip instead of the three or more
 * that walking a full 14-day window takes (#2106, D2).
 */
const NEAR_DAYS_FORWARD = 2;
/** The full forward window, unchanged from #1901a. */
const FULL_DAYS_FORWARD = 14;

/**
 * Upcoming calendar occurrences for the digest's UPCOMING section (#1901a),
 * fetched in two day-sized chunks (#2106, FR2).
 *
 * Per-caller by construction: the procedure reads the caller's own calendar with
 * their delegated Graph token.
 */
export function useUpcomingMeetings({
	projectId,
	organizationId,
	enabled,
}: {
	projectId: string;
	organizationId?: string | null;
	enabled: boolean;
}) {
	const [wantsLater, setWantsLater] = useState(false);

	const nearQuery = useQuery({
		...orpc.projects.meetingDigest.listUpcoming.queryOptions({
			input: {
				projectId,
				organizationId,
				startOffsetDays: 0,
				daysForward: NEAR_DAYS_FORWARD,
			},
		}),
		enabled,
		// The calendar is not a live feed; refetching on every tab focus just
		// burns Graph quota.
		staleTime: 60_000,
	});

	const notConnected = nearQuery.data?.error === "not-connected";

	const laterQuery = useQuery({
		...orpc.projects.meetingDigest.listUpcoming.queryOptions({
			input: {
				projectId,
				organizationId,
				startOffsetDays: NEAR_DAYS_FORWARD,
				daysForward: FULL_DAYS_FORWARD,
			},
		}),
		// There is no point asking Graph for days 2-14 through a connection that
		// does not exist — the section renders its Connect Microsoft CTA instead.
		enabled: enabled && wantsLater && !notConnected,
		staleTime: 60_000,
	});

	const meetings = useMemo(
		() =>
			mergeUpcomingChunks(
				(nearQuery.data?.meetings ?? []) as UpcomingMeeting[],
				(laterQuery.data?.meetings ?? []) as UpcomingMeeting[],
			),
		[nearQuery.data, laterQuery.data],
	);

	// One entry point for both the first request and a retry after failure: an
	// errored query stays enabled, so flipping `wantsLater` again would not
	// re-issue it on its own.
	//
	// Depends on `isError` and `refetch`, NOT on `laterQuery` itself: TanStack
	// hands back a fresh result object every render, so depending on the whole
	// thing made this callback — and therefore LazyDaysSentinel's
	// IntersectionObserver effect — rebuild on every render. `refetch` is stable
	// across renders, so the observer is now created once per mount.
	const { isError: isLaterError, refetch: refetchLater } = laterQuery;
	const loadLater = useCallback(() => {
		setWantsLater(true);
		if (isLaterError) {
			void refetchLater();
		}
	}, [isLaterError, refetchLater]);

	return {
		meetings,
		isLoading: nearQuery.isLoading,
		isError: nearQuery.isError,
		notConnected,
		loadLater,
		isLoadingLater: wantsLater && laterQuery.isFetching,
		isLaterError,
		hasLoadedLater: laterQuery.isSuccess,
	};
}

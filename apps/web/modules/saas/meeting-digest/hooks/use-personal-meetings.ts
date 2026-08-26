"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { useMemo } from "react";

/**
 * Fetch the authenticated user's personal calendar meetings for the digest's
 * "All Meetings" filter (#1899).
 *
 * Separate from useMeetingDigest by design. Keeping the queries independent is
 * what makes the team list render first (personal data is lazily fetched only
 * after opt-in) and what keeps personal rows structurally out of the
 * team-facing listDigest response (FR4).
 *
 * `enabled` is the opt-in gate. When false, no request is made at all — not a
 * request whose result is discarded.
 */
export function usePersonalMeetings({
	projectId,
	organizationId,
	monthDate,
	enabled,
}: {
	projectId: string;
	organizationId: string | null;
	monthDate: Date;
	enabled: boolean;
}) {
	const monthKey = format(monthDate, "yyyy-MM");
	const from = useMemo(() => startOfMonth(monthDate), [monthDate]);
	const to = useMemo(() => endOfMonth(monthDate), [monthDate]);

	const { data, isLoading, isError } = useQuery({
		queryKey: [
			"projects.meetingDigest.listPersonalMeetings",
			projectId,
			organizationId,
			monthKey,
		],
		queryFn: () =>
			orpcClient.projects.meetingDigest.listPersonalMeetings({
				projectId,
				organizationId,
				from,
				to,
			}),
		enabled,
		// Never considered fresh, and garbage-collected the moment the last
		// observer unmounts. NOTE both of these are necessary but NOT
		// sufficient — see the enabled-gating on the return value below.
		staleTime: 0,
		gcTime: 0,
	});

	// Every returned value is gated on `enabled`, not just derived from `data`.
	// React Query does NOT clear a query's cached data when `enabled` flips to
	// false while the component stays mounted: `gcTime: 0` collects a query only
	// once its observer count hits zero, and disabling does not unsubscribe the
	// observer. Since the opt-out UI toggles a flag rather than unmounting the
	// tree, deriving straight from `data` would keep serving the previous
	// user's-calendar rows — subjects, organiser names, join URLs — after they
	// opted out. Verified empirically; do not "simplify" these ternaries away.
	return {
		personalMeetings: enabled ? (data?.meetings ?? []) : [],
		isLoading: enabled && isLoading,
		isError: enabled && isError,
		notConnected: enabled && data?.error === "not-connected",
	};
}

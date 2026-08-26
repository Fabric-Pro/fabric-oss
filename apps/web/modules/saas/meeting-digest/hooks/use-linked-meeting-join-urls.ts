"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * Shared with MeetingTranscriptSyncSettings, which owns the same query under
 * this key. Exported so the digest's link/unlink mutations can invalidate the
 * Settings screen's cache too — the two surfaces mutate the same
 * ProjectLinkedMeeting rows (#1898).
 */
export const LINKED_MEETINGS_QUERY_KEY = "meeting-transcript-sync-linked";

/**
 * joinUrls of meetings already linked to the project. Feeds
 * `LinkedMeetingSelector`'s `existingJoinUrls`, which is how already-linked
 * meetings are excluded from the picker — the picker's own query
 * (`projects.backlog.listMeetings`, which filters to meetings with a
 * `joinUrl`, remaps to a reduced field set, and serves from a 60s per-user
 * Redis cache) does not dedupe against already-linked meetings itself.
 *
 * `listLinkedMeetings` resolves the raw `db.projectLinkedMeeting.findMany()`
 * rows directly (an array, not a `{ meetings: [...] }` envelope), and
 * `joinUrl` is a non-nullable column, so no null-filtering is needed here.
 */
export function useLinkedMeetingJoinUrls({
	projectId,
	organizationId,
	enabled,
}: {
	projectId: string;
	organizationId: string | null;
	enabled: boolean;
}) {
	const { data } = useQuery({
		queryKey: [LINKED_MEETINGS_QUERY_KEY, projectId, organizationId],
		queryFn: () =>
			orpcClient.projects.meetingTranscriptSync.listLinkedMeetings({
				projectId,
				organizationId,
			}),
		enabled,
	});

	const joinUrls = useMemo(
		() => (data ?? []).map((meeting) => meeting.joinUrl),
		[data],
	);

	return { joinUrls };
}

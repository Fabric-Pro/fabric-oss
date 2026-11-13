"use client";

/**
 * Adding meetings from the Context tab, and what is still on its way (Fizzy
 * #3507, FR11 and FR12).
 *
 * The same "Add meeting" actions as the Meeting Digest. A transcript file shows
 * up in the context list as soon as it is sent, already marked as processing,
 * so it needs nothing here. A meeting linked from the calendar has no context
 * row until its first transcript syncs, which can be days for a weekly series,
 * so it is listed here as waiting until then, or as not syncing when the last
 * attempt failed.
 */

import {
	LINKED_MEETINGS_QUERY_KEY,
	useLinkedMeetingJoinUrls,
} from "@saas/meeting-digest/hooks/use-linked-meeting-join-urls";
import { LinkedMeetingSelector } from "@saas/meetings/components";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, ClockIcon } from "lucide-react";
import { useCallback, useState } from "react";
import {
	AddMeetingMenu,
	type MeetingSourcesProject,
	useMeetingSourceDialogs,
} from "./AddMeetingMenu";
import { TranscriptFolderProgress } from "./TranscriptFolderProgress";

/** Syncs run on a schedule of minutes, so a minute is often enough to look. */
const WAITING_POLL_MS = 60_000;

interface LinkedMeetingRow {
	id: string;
	subject: string | null;
	deactivatedAt?: string | Date | null;
	lastErrorMessage?: string | null;
	_count?: { transcripts: number };
}

/** Linked, still syncing, and not one transcript yet. */
export function meetingsAwaitingFirstTranscript(
	rows: LinkedMeetingRow[],
): LinkedMeetingRow[] {
	return rows.filter(
		(row) => !row.deactivatedAt && (row._count?.transcripts ?? 0) === 0,
	);
}

export function ContextMeetingActions({
	projectId,
	organizationId,
	project,
}: {
	projectId: string;
	organizationId: string | null;
	project: MeetingSourcesProject;
}) {
	const queryClient = useQueryClient();
	const [pickerOpen, setPickerOpen] = useState(false);
	const { joinUrls } = useLinkedMeetingJoinUrls({
		projectId,
		organizationId,
		enabled: true,
	});

	const refresh = useCallback(
		() =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: [
						LINKED_MEETINGS_QUERY_KEY,
						projectId,
						organizationId,
					],
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.contexts.list.key(),
				}),
			]).then(() => undefined),
		[queryClient, projectId, organizationId],
	);

	const sourceDialogs = useMeetingSourceDialogs({
		projectId,
		organizationId,
		project,
		onSourcesChanged: refresh,
	});

	return (
		<>
			<AddMeetingMenu
				onAddFromCalendar={() => setPickerOpen(true)}
				onUpload={sourceDialogs.openUpload}
				onConfigureSeries={sourceDialogs.openSeries}
				onConnectFolder={sourceDialogs.openFolder}
			/>
			{sourceDialogs.dialogs}
			<LinkedMeetingSelector
				projectId={projectId}
				organizationId={organizationId}
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onLinked={refresh}
				existingJoinUrls={joinUrls}
			/>
		</>
	);
}

export function ContextMeetingPlaceholders({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}) {
	const queryClient = useQueryClient();
	// The Knowledge settings and the calendar picker read this same query, so a
	// link made anywhere shows up here on the next read. A transcript arrives
	// from a background sync that nothing here hears about, so while a meeting
	// is waiting the list is read again on a slow interval.
	const { data } = useQuery({
		queryKey: [LINKED_MEETINGS_QUERY_KEY, projectId, organizationId],
		queryFn: () =>
			orpcClient.projects.meetingTranscriptSync.listLinkedMeetings({
				projectId,
				organizationId,
			}),
		refetchInterval: (query) =>
			meetingsAwaitingFirstTranscript(
				(query.state.data ?? []) as LinkedMeetingRow[],
			).length > 0
				? WAITING_POLL_MS
				: false,
	});
	// An imported file only has a row on this tab once it was copied in, and
	// the context list stops polling when nothing in it is pending, so the
	// folder progress tells it when to look again.
	const refreshContexts = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.contexts.list.key(),
		});
	}, [queryClient]);
	const waiting = meetingsAwaitingFirstTranscript(
		(data ?? []) as LinkedMeetingRow[],
	);

	return (
		<div className="space-y-2">
			{/* Folder imports run in the background; their progress is shown
			    here as well as in the Meeting Digest (FR15). */}
			<TranscriptFolderProgress
				projectId={projectId}
				organizationId={organizationId}
				onFinished={refreshContexts}
				onImported={refreshContexts}
			/>
			{waiting.length > 0 && (
				<section
					aria-label="Meetings waiting for a transcript"
					className="space-y-2"
				>
					<ul className="divide-y rounded-lg border border-dashed">
						{waiting.map((meeting) => (
							<li
								key={meeting.id}
								className="flex items-start gap-3 p-3"
							>
								{meeting.lastErrorMessage ? (
									<AlertTriangleIcon
										aria-hidden="true"
										className="mt-0.5 size-4 shrink-0 text-highlight"
									/>
								) : (
									<ClockIcon
										aria-hidden="true"
										className="mt-0.5 size-4 shrink-0 text-muted-foreground"
									/>
								)}
								<div className="min-w-0">
									<p className="truncate text-foreground text-sm">
										{meeting.subject ?? "Untitled meeting"}
									</p>
									<p className="text-muted-foreground text-xs">
										{meeting.lastErrorMessage
											? `Not syncing: ${meeting.lastErrorMessage} A project admin can repair it under Configure meeting series.`
											: "Linked. Waiting for its first transcript, which is added here once Teams publishes it."}
									</p>
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

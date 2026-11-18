"use client";

/**
 * Follows a "Sync now" run to its end and says how it went.
 *
 * A run takes minutes, and with scheduled sync off it never changes anything
 * on the page, so without this the button reported only that it had started.
 * A run that Microsoft failed looked the same as one that found nothing new.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const POLL_MS = 5000;
/** Long enough for a run that waits out Microsoft's retries. */
const MAX_WAIT_MS = 15 * 60 * 1000;

type SyncNowStatus = Awaited<
	ReturnType<typeof orpcClient.projects.meetingTranscriptSync.syncNowStatus>
>;

function transcriptsLabel(count: number): string {
	return count === 1 ? "1 new transcript" : `${count} new transcripts`;
}

function announceSyncNowOutcome(
	status: Exclude<SyncNowStatus, { state: "running" }>,
): void {
	switch (status.state) {
		case "failed":
			toast.error("Transcript sync failed", {
				description: status.message,
			});
			return;
		case "completed":
			if (status.failedMeetings > 0) {
				toast.warning(
					`Sync finished with ${transcriptsLabel(status.newTranscripts)}, but some meetings could not be read`,
					{ description: status.message ?? undefined },
				);
				return;
			}
			toast.success(
				status.newTranscripts > 0
					? `Sync finished: ${transcriptsLabel(status.newTranscripts)}`
					: "Sync finished: no new transcripts",
			);
			return;
		default: {
			const unreachable: never = status;
			throw new Error(
				`Unhandled Sync now outcome: ${JSON.stringify(unreachable)}`,
			);
		}
	}
}

export function useSyncNowOutcome({
	projectId,
	organizationId,
	onFinished,
}: {
	projectId: string;
	organizationId: string | null;
	/** Called once the run has ended, so the page can show what it stored. */
	onFinished: () => void;
}) {
	const [workflowId, setWorkflowId] = useState<string | null>(null);
	const watchedSince = useRef(0);

	const { data, isError } = useQuery({
		queryKey: [
			"meeting-transcript-sync-now-status",
			projectId,
			organizationId,
			workflowId,
		],
		queryFn: () =>
			orpcClient.projects.meetingTranscriptSync.syncNowStatus({
				projectId,
				organizationId,
				workflowId: workflowId ?? "",
			}),
		enabled: workflowId !== null,
		refetchInterval: POLL_MS,
		retry: 2,
	});

	useEffect(() => {
		if (workflowId === null) {
			return;
		}
		if (isError) {
			setWorkflowId(null);
			toast.info("Could not check on the sync", {
				description:
					"It may still be running. New transcripts appear here when it finishes.",
			});
			return;
		}
		if (!data) {
			return;
		}
		if (data.state === "running") {
			if (Date.now() - watchedSince.current > MAX_WAIT_MS) {
				setWorkflowId(null);
				toast.info("The sync is still running", {
					description:
						"New transcripts appear here when it finishes.",
				});
			}
			return;
		}
		setWorkflowId(null);
		announceSyncNowOutcome(data);
		onFinished();
	}, [data, isError, workflowId, onFinished]);

	const watch = useCallback((id: string) => {
		watchedSince.current = Date.now();
		setWorkflowId(id);
	}, []);

	return { watch, isSyncing: workflowId !== null };
}

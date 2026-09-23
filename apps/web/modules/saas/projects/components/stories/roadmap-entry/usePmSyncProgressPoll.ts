"use client";

/**
 * Polls a running PM story sync and reports how it ended (Fizzy #2204).
 *
 * Moved out of `StoriesRoadmap` unchanged in behaviour, then extended:
 *
 *  - a completed run waits a bounded number of extra polls for its job row to
 *    close, because only the row proves the run really completed;
 *  - the outcome is resolved once, and handed to `onTerminal` so Do both can
 *    continue from it;
 *  - a finished run refreshes the capability gates and `projects.get`, whose
 *    PM verdicts and `activePmSync` it just changed;
 *  - a sync that was already running when the page loaded is picked up from
 *    `project.roadmap.activePmSync`, once per workflow.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { RoadmapBlock } from "./entry-point-states";
import {
	describeSyncOutcome,
	isTerminalSyncStatus,
	type SyncJobStatus,
	type SyncProgressSnapshot,
	shouldAwaitJobClose,
} from "./sync-outcome";

type SyncDirection = "push" | "pull";

export interface PmSyncTerminal {
	workflowId: string;
	direction: SyncDirection | null;
	jobStatus: SyncJobStatus;
	/** Null when the poll gave up without a readable outcome. */
	progress: SyncProgressSnapshot | null;
}

interface PmSyncDisplayProgress {
	status: string;
	syncedCount: number;
	totalStories: number;
	message: string;
}

interface PmSyncProgressPollArgs {
	projectId: string;
	organizationId: string | null;
	pmToolName: string;
	/** `project.roadmap.activePmSync`; undefined while `projects.get` loads. */
	activePmSync: RoadmapBlock["activePmSync"] | undefined;
	onReviewConflicts: () => void;
	onTerminal?: (outcome: PmSyncTerminal) => void;
}

const POLL_INTERVAL_MS = 1000;

export function usePmSyncProgressPoll({
	projectId,
	organizationId,
	pmToolName,
	activePmSync,
	onReviewConflicts,
	onTerminal,
}: PmSyncProgressPollArgs) {
	const queryClient = useQueryClient();
	const [workflowId, setWorkflowId] = useState<string | null>(null);
	const [direction, setDirection] = useState<SyncDirection | null>(null);
	const [progress, setProgress] = useState<PmSyncDisplayProgress | null>(
		null,
	);
	// Every workflow this page has tracked, so a lagging `activePmSync` never
	// re-seeds a run whose outcome was already reported.
	const trackedRef = useRef(new Set<string>());

	// Read at resolution time rather than restarting the poll when they change.
	const latest = useRef({
		direction,
		pmToolName,
		onReviewConflicts,
		onTerminal,
	});
	latest.current = { direction, pmToolName, onReviewConflicts, onTerminal };

	// The workflow being polled, readable from `track` without re-creating it.
	const activeRef = useRef<{
		workflowId: string;
		direction: SyncDirection;
	} | null>(null);

	const track = useCallback(
		(
			id: string,
			dir: SyncDirection,
			initial: PmSyncDisplayProgress,
		): void => {
			// A second sync replaces the one being polled, whose poll then
			// stops. Report the replaced run as unresolved rather than leaving
			// whoever waits on it (Do both) waiting forever.
			const replaced = activeRef.current;
			if (replaced && replaced.workflowId !== id) {
				latest.current.onTerminal?.({
					workflowId: replaced.workflowId,
					direction: replaced.direction,
					jobStatus: null,
					progress: null,
				});
			}
			activeRef.current = { workflowId: id, direction: dir };
			trackedRef.current.add(id);
			setWorkflowId(id);
			setDirection(dir);
			setProgress(initial);
		},
		[],
	);

	useEffect(() => {
		if (!activePmSync || workflowId !== null) {
			return;
		}
		if (trackedRef.current.has(activePmSync.workflowId)) {
			return;
		}
		track(activePmSync.workflowId, activePmSync.direction, {
			status: "syncing",
			syncedCount: 0,
			totalStories: 0,
			message:
				activePmSync.direction === "push"
					? "Pushing to PM…"
					: "Pulling from PM…",
		});
	}, [activePmSync, workflowId, track]);

	useEffect(() => {
		if (!workflowId) {
			return;
		}
		const storiesQueryKey = orpc.projects.stories.list.queryKey({
			input: { projectId, organizationId },
		});

		let stopped = false;
		let interval: ReturnType<typeof setInterval> | null = null;
		// Tolerate transient errors (a one-off 500 during a worker deploy or a
		// gRPC blip) instead of treating the first failure as "Sync failed";
		// only give up after several consecutive failures.
		let consecutivePollErrors = 0;
		let gracePollsUsed = 0;

		/** False once another sync replaced this one; `track` reported it. */
		const stillActive = () => activeRef.current?.workflowId === workflowId;

		const finish = (outcome: PmSyncTerminal) => {
			if (stopped) {
				return;
			}
			stopped = true;
			if (interval) {
				clearInterval(interval);
			}
			activeRef.current = null;
			setWorkflowId(null);
			setDirection(null);
			setProgress(null);
			queryClient.invalidateQueries({ queryKey: storiesQueryKey });
			queryClient.invalidateQueries({ queryKey: ["capability-gates"] });
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
			latest.current.onTerminal?.(outcome);
		};

		const pollProgress = async () => {
			try {
				const result = await orpcClient.projects.stories.syncProgress({
					projectId,
					workflowId,
					organizationId,
				});
				if (stopped || !stillActive()) {
					return;
				}
				consecutivePollErrors = 0;

				setProgress({
					status: result.status,
					syncedCount: result.syncedCount,
					totalStories: result.totalStories,
					message: result.message,
				});

				if (result.syncedCount > 0) {
					queryClient.invalidateQueries({
						queryKey: storiesQueryKey,
					});
				}

				if (!isTerminalSyncStatus(result.status)) {
					return;
				}
				const jobStatus = result.jobStatus ?? null;
				if (shouldAwaitJobClose(result, jobStatus, gracePollsUsed)) {
					gracePollsUsed += 1;
					return;
				}

				const { direction: dir, pmToolName: tool } = latest.current;
				const spec = describeSyncOutcome({
					progress: result,
					jobStatus,
					direction: dir,
					pmToolName: tool,
				});
				toast[spec.tone](spec.title, {
					description: spec.description,
					duration: spec.duration,
					action: spec.reviewConflicts
						? {
								label: "Review conflicts",
								onClick: () =>
									latest.current.onReviewConflicts(),
							}
						: undefined,
				});
				finish({
					workflowId,
					direction: dir,
					jobStatus,
					progress: result,
				});
			} catch (error) {
				if (stopped || !stillActive()) {
					return;
				}
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				const workflowGone =
					errorMessage.includes("not found") ||
					errorMessage.includes("already completed");

				// Keep polling unless the workflow is gone or the errors
				// persist across several consecutive polls.
				if (!workflowGone && ++consecutivePollErrors < 4) {
					return;
				}

				if (workflowGone) {
					toast.info("Sync finished");
				} else {
					toast.error("Sync failed", { description: errorMessage });
				}
				finish({
					workflowId,
					direction: latest.current.direction,
					jobStatus: null,
					progress: null,
				});
			}
		};

		pollProgress();
		interval = setInterval(pollProgress, POLL_INTERVAL_MS);

		return () => {
			stopped = true;
			if (interval) {
				clearInterval(interval);
			}
		};
	}, [workflowId, projectId, organizationId, queryClient]);

	return { workflowId, direction, progress, track };
}

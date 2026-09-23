"use client";

/**
 * Do both: pull from the PM tool, then recommend (Fizzy #2204, FR21–FR27,
 * FR45).
 *
 * A client-side reducer. Step 2 starts only when the pull's job row closed
 * COMPLETED with no failed items — a partial-failure pull still closes
 * COMPLETED, so the count matters. A pull whose outcome cannot be confirmed
 * (no row, or a row that never closed within the grace polls) never starts a
 * recommendation on its own; the viewer is offered Recommend by hand.
 *
 * How the pull ended rides along into the recommendation steps, so a manual
 * "Recommend features instead" after a failed or unconfirmed pull is never
 * reported as "Pulled", and never sent as DO_BOTH_AFTER_PULL.
 *
 * A running pull survives the Roadmap unmounting (a tab switch): the step is
 * kept in sessionStorage per project and picked up again when the page
 * remounts and `activePmSync` still names the same workflow. A pull that
 * finished while the page was away is not resumed — its outcome is no longer
 * observable here — and neither is anything across a reload's new tab.
 */

import { useAnalytics } from "@analytics";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { RecommendationStartError } from "../recommendations/useRecommendationRun";
import type { RoadmapRecommendationStarter } from "./recommendation-starter";
import type { SyncJobStatus } from "./sync-outcome";

/**
 * How step 1 ended, as far as step 2 is concerned. `nothing-new` is the pull
 * dialog finding nothing left to import (FR44), which continues like a clean
 * pull (FR45).
 */
export type DoBothPullOutcome = "done" | "nothing-new" | "failed" | "unknown";

/** A failure to start step 2: the gate's headline apart from its body (FR37). */
interface DoBothFailure {
	title: string | null;
	body: string;
}

export type DoBothState =
	| { step: "idle" }
	| { step: "selecting" }
	| { step: "pulling"; workflowId: string }
	| { step: "pull-failed"; message: string | null }
	| { step: "pull-unknown"; workflowId: string | null }
	| {
			step: "recommending";
			pull: DoBothPullOutcome;
			/** Set only for a pull that completed: the run may read it. */
			pullWorkflowId: string | null;
	  }
	| { step: "recommend-started"; pull: DoBothPullOutcome }
	| {
			step: "recommend-failed";
			failure: DoBothFailure;
			pull: DoBothPullOutcome;
	  };

type DoBothEvent =
	| { type: "BEGIN" }
	| { type: "DIALOG_CLOSED" }
	/** The pull dialog found nothing new to import. */
	| { type: "NOTHING_NEW" }
	| { type: "PULL_STARTED"; workflowId: string }
	/** The page remounted while the pull it had started is still running. */
	| { type: "RESTORE"; workflowId: string }
	| { type: "PULL_START_FAILED"; message: string }
	| {
			type: "PULL_FINISHED";
			workflowId: string;
			jobStatus: SyncJobStatus;
			failedCount: number;
	  }
	| { type: "RETRY_PULL" }
	| { type: "RECOMMEND_INSTEAD" }
	| { type: "RECOMMEND_STARTED" }
	| { type: "RECOMMEND_FAILED"; failure: DoBothFailure }
	| { type: "RESET" };

export const DO_BOTH_IDLE: DoBothState = { step: "idle" };

/** Steps from which the viewer may start over or recommend by hand. */
function isSettled(state: DoBothState): boolean {
	return (
		state.step === "idle" ||
		state.step === "pull-failed" ||
		state.step === "pull-unknown" ||
		state.step === "recommend-started" ||
		state.step === "recommend-failed"
	);
}

export function doBothReducer(
	state: DoBothState,
	event: DoBothEvent,
): DoBothState {
	switch (event.type) {
		case "BEGIN":
		case "RETRY_PULL":
			return isSettled(state) ? { step: "selecting" } : state;
		case "DIALOG_CLOSED":
			return state.step === "selecting" ? DO_BOTH_IDLE : state;
		case "NOTHING_NEW":
			return state.step === "selecting"
				? {
						step: "recommending",
						pull: "nothing-new",
						pullWorkflowId: null,
					}
				: state;
		case "RESTORE":
			return state.step === "idle"
				? { step: "pulling", workflowId: event.workflowId }
				: state;
		case "PULL_STARTED":
			return state.step === "selecting"
				? { step: "pulling", workflowId: event.workflowId }
				: state;
		case "PULL_START_FAILED":
			return state.step === "selecting"
				? { step: "pull-failed", message: event.message }
				: state;
		case "PULL_FINISHED": {
			// Only the pull this sequence started. A sync seeded after a reload
			// or started from the toolbar must never trigger a recommendation.
			if (
				state.step !== "pulling" ||
				state.workflowId !== event.workflowId
			) {
				return state;
			}
			if (event.jobStatus === "COMPLETED" && event.failedCount === 0) {
				return {
					step: "recommending",
					pull: "done",
					pullWorkflowId: event.workflowId,
				};
			}
			if (
				event.jobStatus === "COMPLETED" ||
				event.jobStatus === "FAILED"
			) {
				return { step: "pull-failed", message: null };
			}
			return { step: "pull-unknown", workflowId: event.workflowId };
		}
		case "RECOMMEND_INSTEAD":
			// The pull's real outcome goes along: an unconfirmed pull is not a
			// pull that happened.
			switch (state.step) {
				case "pull-unknown":
					return {
						step: "recommending",
						pull: "unknown",
						pullWorkflowId: null,
					};
				case "pull-failed":
					return {
						step: "recommending",
						pull: "failed",
						pullWorkflowId: null,
					};
				case "recommend-failed":
					return {
						step: "recommending",
						pull: state.pull,
						pullWorkflowId: null,
					};
				default:
					return state;
			}
		case "RECOMMEND_STARTED":
			return state.step === "recommending"
				? { step: "recommend-started", pull: state.pull }
				: state;
		case "RECOMMEND_FAILED":
			return state.step === "recommending"
				? {
						step: "recommend-failed",
						failure: event.failure,
						pull: state.pull,
					}
				: state;
		case "RESET":
			return isSettled(state) ? DO_BOTH_IDLE : state;
	}
}

/** Whether step 2 ran on the back of a pull that finished cleanly. */
function pullSucceeded(pull: DoBothPullOutcome): boolean {
	return pull === "done" || pull === "nothing-new";
}

const STORAGE_PREFIX = "fabric:roadmap-do-both:";

function readStoredPull(projectId: string): string | null {
	try {
		const raw = window.sessionStorage.getItem(STORAGE_PREFIX + projectId);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as {
			step?: unknown;
			workflowId?: unknown;
		};
		return parsed.step === "pulling" &&
			typeof parsed.workflowId === "string"
			? parsed.workflowId
			: null;
	} catch {
		return null;
	}
}

function writeStoredPull(projectId: string, workflowId: string | null) {
	try {
		const key = STORAGE_PREFIX + projectId;
		if (workflowId === null) {
			window.sessionStorage.removeItem(key);
		} else {
			window.sessionStorage.setItem(
				key,
				JSON.stringify({ step: "pulling", workflowId }),
			);
		}
	} catch {
		// Storage unavailable (private window, blocked site data): the
		// sequence still runs, it just cannot outlive the page.
	}
}

interface DoBothSequenceArgs {
	projectId: string;
	/**
	 * `project.roadmap.activePmSync?.workflowId`: undefined while the project
	 * loads, null when no sync is running.
	 */
	activePmSyncWorkflowId: string | null | undefined;
	/** The Roadmap has no items at all; decides the manual entry point. */
	roadmapEmpty: boolean;
}

export function useDoBothSequence(
	starter: RoadmapRecommendationStarter | null,
	{ projectId, activePmSyncWorkflowId, roadmapEmpty }: DoBothSequenceArgs,
) {
	const t = useTranslations("projects.recommendations");
	const [state, dispatch] = useReducer(doBothReducer, DO_BOTH_IDLE);
	const { trackEvent } = useAnalytics();
	const trackRef = useRef(trackEvent);
	trackRef.current = trackEvent;
	const starterRef = useRef(starter);
	starterRef.current = starter;
	const roadmapEmptyRef = useRef(roadmapEmpty);
	roadmapEmptyRef.current = roadmapEmpty;
	const copyRef = useRef({ unavailable: "", generationFailed: "" });
	copyRef.current = {
		unavailable: t("unavailable"),
		generationFailed: t("generationFailed"),
	};

	// Keep a running pull in sessionStorage; forget it only once the step
	// moves on, never on unmount (StrictMode's double mount would wipe it).
	const previousStepRef = useRef(state.step);
	useEffect(() => {
		if (state.step === "pulling") {
			writeStoredPull(projectId, state.workflowId);
		} else if (previousStepRef.current === "pulling") {
			writeStoredPull(projectId, null);
		}
		previousStepRef.current = state.step;
	}, [state, projectId]);

	// Pick the pull back up after a remount, once the project says which
	// sync is running. A stored pull superseded by another sync is stale. No
	// running sync proves nothing: the cached project can predate the pull,
	// and its refetch re-runs this.
	const stepRef = useRef(state.step);
	stepRef.current = state.step;
	useEffect(() => {
		if (!activePmSyncWorkflowId || stepRef.current !== "idle") {
			return;
		}
		const stored = readStoredPull(projectId);
		if (stored === null) {
			return;
		}
		if (stored === activePmSyncWorkflowId) {
			dispatch({ type: "RESTORE", workflowId: stored });
		} else {
			writeStoredPull(projectId, null);
		}
	}, [projectId, activePmSyncWorkflowId]);

	// One start per entry into `recommending`, however often React re-renders.
	const startedForRef = useRef<DoBothState | null>(null);
	useEffect(() => {
		if (state.step !== "recommending" || startedForRef.current === state) {
			return;
		}
		startedForRef.current = state;
		const current = starterRef.current;
		if (!current) {
			dispatch({
				type: "RECOMMEND_FAILED",
				failure: { title: null, body: copyRef.current.unavailable },
			});
			return;
		}
		const afterPull = pullSucceeded(state.pull);
		const { pullWorkflowId } = state;
		current
			.start(
				afterPull
					? {
							entryPoint: "DO_BOTH_AFTER_PULL",
							...(pullWorkflowId
								? { precedingPullWorkflowId: pullWorkflowId }
								: {}),
						}
					: {
							entryPoint: roadmapEmptyRef.current
								? "EMPTY_ROADMAP"
								: "MATURE_ROADMAP",
						},
			)
			.then(() => {
				trackRef.current("roadmap_do_both_recommend_started", {
					afterPull,
				});
				dispatch({ type: "RECOMMEND_STARTED" });
			})
			.catch((error: unknown) => {
				trackRef.current("roadmap_do_both_recommend_failed", {});
				dispatch({
					type: "RECOMMEND_FAILED",
					failure: {
						title:
							error instanceof RecommendationStartError
								? error.title
								: null,
						body:
							error instanceof Error
								? error.message
								: copyRef.current.generationFailed,
					},
				});
			});
	}, [state]);

	const begin = useCallback(() => {
		trackRef.current("roadmap_do_both_started", {});
		dispatch({ type: "BEGIN" });
	}, []);

	const pullFinished = useCallback(
		(outcome: {
			workflowId: string;
			jobStatus: SyncJobStatus;
			failedCount: number;
		}) => {
			dispatch({ type: "PULL_FINISHED", ...outcome });
		},
		[],
	);

	return {
		state,
		begin,
		dialogClosed: useCallback(
			() => dispatch({ type: "DIALOG_CLOSED" }),
			[],
		),
		nothingNew: useCallback(() => dispatch({ type: "NOTHING_NEW" }), []),
		pullStarted: useCallback(
			(workflowId: string) =>
				dispatch({ type: "PULL_STARTED", workflowId }),
			[],
		),
		pullStartFailed: useCallback(
			(message: string) =>
				dispatch({ type: "PULL_START_FAILED", message }),
			[],
		),
		pullFinished,
		retryPull: useCallback(() => dispatch({ type: "RETRY_PULL" }), []),
		recommendInstead: useCallback(
			() => dispatch({ type: "RECOMMEND_INSTEAD" }),
			[],
		),
		reset: useCallback(() => dispatch({ type: "RESET" }), []),
	};
}

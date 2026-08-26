/**
 * Coding Run Workflow
 *
 * Manages the lifecycle of a background agent coding execution session.
 * For BACKGROUND_AGENTS: hybrid signal+poll approach (fast signal, 5-min fallback).
 * For KANBAN_LOCAL: pure 15s poll loop.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	CancellationScope,
	condition,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	sleep,
	workflowInfo,
} from "@temporalio/workflow";
import type * as allActivities from "../activities";
import type * as codingRunActivities from "../activities/coding-run";

const {
	updateCodingRunStatusActivity,
	addCodingRunEventActivity,
	buildImplementationPrompt,
	createExecutionSession,
	sendExecutionPrompt,
	pollExecutionStatus,
	syncCodingRunArtifacts,
	cancelExecutionSession,
} = proxyActivities<typeof codingRunActivities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Session lifecycle cleanup — runs from the workflow's finally block
// inside `CancellationScope.nonCancellable` so it fires on every exit
// path (success, error, poll-exhausted, cancel, exception, timeout).
const { cleanupWeaveResourcesActivity } = proxyActivities<typeof allActivities>(
	{
		startToCloseTimeout: "2 minutes",
		retry: {
			initialInterval: "1s",
			backoffCoefficient: 2,
			maximumInterval: "10s",
			maximumAttempts: 3,
		},
	},
);

const { pollExecutionStatus: pollStatus } = proxyActivities<
	typeof codingRunActivities
>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "10s",
		maximumAttempts: 2,
	},
});

export const cancelCodingRunSignal = defineSignal("cancelCodingRun");
export const codingRunStatusQuery =
	defineQuery<CodingRunWorkflowStatus>("codingRunStatus");
export const providerCompleteSignal =
	defineSignal<[ProviderCompletePayload]>("providerComplete");

export interface CodingRunWorkflowInput {
	codingRunId: string;
	projectId: string;
	storyId: string;
	storyTaskId?: string;
	userId: string;
	organizationId?: string;
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
	projectName?: string;
	organizationName?: string;
	repositoryOwner: string;
	repositoryName: string;
	targetBranch?: string;
	workingDirectory?: string;
	storyTitle: string;
}

export interface CodingRunWorkflowOutput {
	codingRunId: string;
	status: "completed" | "failed" | "cancelled";
	pullRequestUrl?: string;
	error?: string;
}

export interface CodingRunWorkflowStatus {
	codingRunId: string;
	status: string;
	sessionId: string | null;
	pullRequestUrl: string | null;
	pollCount: number;
}

export interface ProviderCompletePayload {
	providerStatus: "completed" | "failed" | "stopped";
	pullRequestUrl?: string;
	branchName?: string;
	error?: string;
}

const POLL_INTERVAL_SECONDS = 15;
const MAX_POLL_ITERATIONS = 360; // 90 minutes
const SIGNAL_WAIT_SECONDS = 300; // 5 minutes

const TERMINAL_PROVIDER_STATUSES = new Set([
	"completed",
	"failed",
	"stopped",
	"archived",
]);

export async function codingRunWorkflow(
	input: CodingRunWorkflowInput,
): Promise<CodingRunWorkflowOutput> {
	const {
		codingRunId,
		projectId,
		storyId,
		userId,
		organizationId,
		provider,
		projectName,
		organizationName,
		repositoryOwner,
		repositoryName,
		targetBranch,
		workingDirectory,
		storyTitle,
	} = input;

	const { workflowId } = workflowInfo();

	const state = {
		cancelled: false,
		currentStatus: "STARTING",
		sessionId: null as string | null,
		pullRequestUrl: null as string | null,
		pollCount: 0,
		signalReceived: false,
		signalPayload: null as ProviderCompletePayload | null,
	};

	log.info("Starting coding run workflow", {
		codingRunId,
		storyId,
		workflowId,
	});

	setHandler(cancelCodingRunSignal, () => {
		log.info("Received cancel signal", { codingRunId });
		state.cancelled = true;
	});

	setHandler(providerCompleteSignal, (payload: ProviderCompletePayload) => {
		log.info("Received providerComplete signal", {
			codingRunId,
			providerStatus: payload.providerStatus,
		});
		state.signalReceived = true;
		state.signalPayload = payload;
		if (payload.pullRequestUrl) {
			state.pullRequestUrl = payload.pullRequestUrl;
		}
	});

	setHandler(codingRunStatusQuery, () => ({
		codingRunId,
		status: state.currentStatus,
		sessionId: state.sessionId,
		pullRequestUrl: state.pullRequestUrl,
		pollCount: state.pollCount,
	}));

	// `Date.now()` is replay-safe under SDK 1.16 + reuseV8Context. Captured
	// once at the top so the finally-block sees the same elapsed time
	// regardless of which exit path ran.
	const workflowStartedAtMs = Date.now();
	let exitReason:
		| "success"
		| "failure"
		| "cancelled"
		| "timeout"
		| "exception"
		| "oauth_blocked" = "exception";

	try {
		await updateCodingRunStatusActivity({
			codingRunId,
			status: "STARTING",
		});
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "workflow_started",
			payload: { storyId, projectId, storyTitle },
		});

		if (state.cancelled) {
			exitReason = "cancelled";
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
			);
		}

		const prompt = await buildImplementationPrompt({
			storyId,
			projectId,
			storyTaskId: input.storyTaskId,
			userId,
			organizationId,
			repositoryOwner,
			repositoryName,
			targetBranch,
			workingDirectory,
		});
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "prompt_built",
			payload: { promptLength: prompt.length },
		});

		if (state.cancelled) {
			exitReason = "cancelled";
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
			);
		}

		const sessionResult = await createExecutionSession({
			provider,
			repoOwner: repositoryOwner,
			repoName: repositoryName,
			projectName,
			organizationName,
			title: `Fabric: ${storyTitle}`,
			branch: targetBranch,
			userId,
			workingDirectory,
			promptText: prompt,
			codingRunId,
			workflowId,
			organizationId,
			projectId,
		});
		state.sessionId = sessionResult.sessionId;

		state.currentStatus = "RUNNING";
		await updateCodingRunStatusActivity({
			codingRunId,
			status: "RUNNING",
			data: {
				providerSessionId: state.sessionId,
				externalUrl: sessionResult.externalUrl,
				externalStatus:
					sessionResult.externalStatus ?? "session_created",
				providerMetadata: sessionResult.providerMetadata,
			},
		});
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "session_created",
			payload: { sessionId: state.sessionId },
		});

		if (state.cancelled) {
			exitReason = "cancelled";
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
			);
		}

		await sendExecutionPrompt({
			provider,
			sessionId: state.sessionId,
			content: prompt,
			authorId: userId,
			projectId,
		});
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "prompt_sent",
		});

		let finalProviderStatus = "active";
		if (provider === "BACKGROUND_AGENTS") {
			finalProviderStatus = await runHybridLoop(
				codingRunId,
				state.sessionId,
				provider,
				state,
			);
		} else {
			finalProviderStatus = await runPollLoop(
				codingRunId,
				state.sessionId,
				provider,
				state,
			);
		}

		if (state.cancelled) {
			exitReason = "cancelled";
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
			);
		}

		if (state.sessionId) {
			try {
				await syncCodingRunArtifacts({
					codingRunId,
					provider,
					sessionId: state.sessionId,
				});
			} catch {
				/* non-critical */
			}
		}

		if (
			finalProviderStatus === "completed" ||
			(finalProviderStatus === "active" && state.pullRequestUrl)
		) {
			const finalFabricStatus =
				state.currentStatus === "PR_OPENED"
					? "PR_OPENED"
					: state.currentStatus === "AWAITING_REVIEW"
						? "AWAITING_REVIEW"
						: "COMPLETED";
			state.currentStatus = finalFabricStatus;
			await updateCodingRunStatusActivity({
				codingRunId,
				status: finalFabricStatus,
			});
			await addCodingRunEventActivity({
				codingRunId,
				eventType: "workflow_completed",
				payload: {
					pullRequestUrl: state.pullRequestUrl,
					pollCount: state.pollCount,
				},
			});
			exitReason = "success";
			return {
				codingRunId,
				status: "completed",
				pullRequestUrl: state.pullRequestUrl ?? undefined,
			};
		}

		if (finalProviderStatus === "stopped") {
			state.currentStatus = "CANCELLED";
			await updateCodingRunStatusActivity({
				codingRunId,
				status: "CANCELLED",
			});
			exitReason = "cancelled";
			return {
				codingRunId,
				status: "cancelled",
				error: "Session was stopped by the provider",
			};
		}

		const isTimeout = !TERMINAL_PROVIDER_STATUSES.has(finalProviderStatus);
		const errorMessage = isTimeout
			? `Coding run timed out after ${(MAX_POLL_ITERATIONS * POLL_INTERVAL_SECONDS) / 60} minutes`
			: "Coding agent session failed";

		state.currentStatus = "FAILED";
		await updateCodingRunStatusActivity({ codingRunId, status: "FAILED" });
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "workflow_failed",
			payload: {
				error: errorMessage,
				finalProviderStatus,
				pollCount: state.pollCount,
			},
		});
		exitReason = isTimeout ? "timeout" : "failure";
		return {
			codingRunId,
			status: "failed",
			pullRequestUrl: state.pullRequestUrl ?? undefined,
			error: errorMessage,
		};
	} catch (error) {
		const errorMsg = extractErrorMessage(error);
		log.error("Coding run workflow error", {
			codingRunId,
			error: errorMsg,
		});
		state.currentStatus = "FAILED";
		// Leave `exitReason` as its default `"exception"` so the audit
		// log distinguishes unhandled throws from the deliberate
		// `"failure"` return above.
		try {
			await updateCodingRunStatusActivity({
				codingRunId,
				status: "FAILED",
			});
			await addCodingRunEventActivity({
				codingRunId,
				eventType: "workflow_error",
				payload: { error: errorMsg },
			});
		} catch {
			/* best effort */
		}
		return { codingRunId, status: "failed", error: errorMsg };
	} finally {
		// Tear down the provider's control-plane session on every exit
		// path. The existing `handleCancellation` already calls
		// `cancelExecutionSession` for the explicit cancel branch; the
		// duplicate call here is idempotent (the cleanup activity treats
		// 404 / not-found as success). Wrapped in
		// `CancellationScope.nonCancellable` so the activity runs even
		// when the workflow itself was cancelled.
		//
		// `patched()` is required because this cleanup activity was added in
		// PR #1243 — pre-#1243 histories don't have the ActivityTaskScheduled
		// event at this position, so replaying them under post-#1243 code
		// produces a nondeterminism error
		// ("Activity machine does not handle this event:
		// HistoryEvent(id: N, WorkflowExecutionCompleted)"). The patch
		// marker is recorded in NEW histories only — pre-#1243 histories
		// replay deterministically by skipping this branch, while new runs
		// always execute it. Patch id is intentionally workflow-scoped:
		// never reuse or rename.
		if (patched("coding-run-cleanup-on-exit-v1")) {
			await CancellationScope.nonCancellable(async () => {
				await cleanupWeaveResourcesActivity({
					sessionId: state.sessionId,
					provider,
					userId,
					organizationId: organizationId ?? null,
					codingRunId,
					exitReason,
					workflowId,
					runDurationMs: Date.now() - workflowStartedAtMs,
				});
			});
		}
	}
}

async function runHybridLoop(
	codingRunId: string,
	sessionId: string,
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
	state: {
		cancelled: boolean;
		currentStatus: string;
		pullRequestUrl: string | null;
		pollCount: number;
		signalReceived: boolean;
		signalPayload: ProviderCompletePayload | null;
	},
): Promise<string> {
	const signalArrived = await condition(
		() => state.signalReceived || state.cancelled,
		`${SIGNAL_WAIT_SECONDS} seconds`,
	);

	if (state.cancelled) {
		return "active";
	}

	if (signalArrived && state.signalPayload) {
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "provider_complete_signal",
			payload: {
				providerStatus: state.signalPayload.providerStatus,
				pullRequestUrl: state.signalPayload.pullRequestUrl,
				branchName: state.signalPayload.branchName,
			},
		});

		if (
			state.signalPayload.pullRequestUrl &&
			state.currentStatus !== "PR_OPENED"
		) {
			state.pullRequestUrl = state.signalPayload.pullRequestUrl;
			state.currentStatus = "PR_OPENED";
			await updateCodingRunStatusActivity({
				codingRunId,
				status: "PR_OPENED",
			});
			await syncCodingRunArtifacts({ codingRunId, provider, sessionId });
		}

		return state.signalPayload.providerStatus;
	}

	log.info(
		"No providerComplete signal within window, falling back to polling",
		{ codingRunId, waitSeconds: SIGNAL_WAIT_SECONDS },
	);
	await addCodingRunEventActivity({
		codingRunId,
		eventType: "fallback_poll_status",
		payload: { reason: "signal_timeout", waitSeconds: SIGNAL_WAIT_SECONDS },
	});

	return await runPollLoop(codingRunId, sessionId, provider, state);
}

async function runPollLoop(
	codingRunId: string,
	sessionId: string,
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
	state: {
		cancelled: boolean;
		currentStatus: string;
		pullRequestUrl: string | null;
		pollCount: number;
		signalReceived: boolean;
	},
): Promise<string> {
	let finalProviderStatus = "active";

	for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
		if (state.cancelled) {
			return finalProviderStatus;
		}
		if (state.signalReceived) {
			log.info("Signal received during fallback polling, exiting", {
				codingRunId,
			});
			return "completed";
		}

		await sleep(`${POLL_INTERVAL_SECONDS} seconds`);
		state.pollCount = i + 1;
		if (state.cancelled) {
			return finalProviderStatus;
		}

		let statusResult: Awaited<ReturnType<typeof pollExecutionStatus>>;
		try {
			statusResult = await pollStatus({ provider, sessionId });
		} catch (pollError) {
			const errMsg = extractErrorMessage(pollError);
			log.warn("Poll failed, will retry", {
				codingRunId,
				pollCount: state.pollCount,
				error: errMsg,
			});
			await addCodingRunEventActivity({
				codingRunId,
				eventType: "fallback_poll_error",
				payload: { error: errMsg, pollCount: state.pollCount },
			});
			continue;
		}

		finalProviderStatus = statusResult.providerStatus;

		await addCodingRunEventActivity({
			codingRunId,
			eventType: "poll_status",
			payload: {
				providerStatus: statusResult.providerStatus,
				fabricStatus: statusResult.fabricStatus,
				branchName: statusResult.branchName,
				hasPr: !!statusResult.pullRequestUrl,
				pollCount: state.pollCount,
			},
		});

		if (
			statusResult.fabricStatus !== state.currentStatus &&
			!(
				statusResult.pullRequestUrl &&
				statusResult.fabricStatus === "PR_OPENED"
			)
		) {
			state.currentStatus = statusResult.fabricStatus;
			await updateCodingRunStatusActivity({
				codingRunId,
				status: statusResult.fabricStatus,
			});
		}

		if (
			statusResult.pullRequestUrl &&
			state.currentStatus !== "PR_OPENED"
		) {
			state.pullRequestUrl = statusResult.pullRequestUrl;
			state.currentStatus = "PR_OPENED";
			await syncCodingRunArtifacts({ codingRunId, provider, sessionId });
			await addCodingRunEventActivity({
				codingRunId,
				eventType: "pr_opened",
				payload: {
					pullRequestUrl: statusResult.pullRequestUrl,
					branchName: statusResult.branchName,
				},
			});
		}

		if (TERMINAL_PROVIDER_STATUSES.has(statusResult.providerStatus)) {
			log.info("Provider reached terminal state", {
				codingRunId,
				providerStatus: statusResult.providerStatus,
				pollCount: state.pollCount,
			});
			break;
		}
	}

	return finalProviderStatus;
}

async function handleCancellation(
	codingRunId: string,
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
	sessionId: string | null,
): Promise<CodingRunWorkflowOutput> {
	log.info("Cancelling coding run", { codingRunId, sessionId });
	if (sessionId) {
		try {
			await cancelExecutionSession({ provider, sessionId });
		} catch (e) {
			log.warn("Failed to cancel execution session", {
				codingRunId,
				error: extractErrorMessage(e),
			});
		}
	}
	try {
		await updateCodingRunStatusActivity({
			codingRunId,
			status: "CANCELLED",
		});
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "workflow_cancelled",
		});
	} catch {
		/* best effort */
	}
	return { codingRunId, status: "cancelled" };
}

function extractErrorMessage(error: unknown): string {
	if (!error) {
		return "Unknown error";
	}
	if (error instanceof ActivityFailure) {
		return error.cause ? extractErrorMessage(error.cause) : error.message;
	}
	if (error instanceof ApplicationFailure) {
		if (error.cause) {
			const m = extractErrorMessage(error.cause);
			if (m && m !== "Unknown error") {
				return m;
			}
		}
		return error.message;
	}
	if (error instanceof Error) {
		const anyError = error as { cause?: unknown };
		if (anyError.cause) {
			const m = extractErrorMessage(anyError.cause);
			if (
				m &&
				m !== "Unknown error" &&
				!m.includes("Activity task failed")
			) {
				return m;
			}
		}
		return error.message;
	}
	return String(error);
}

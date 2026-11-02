/**
 * Coding Run Workflow
 *
 * Manages the lifecycle of a background agent coding execution session.
 * For BACKGROUND_AGENTS: hybrid signal+poll approach (fast signal, 5-min fallback).
 * For KANBAN_LOCAL: pure 15s poll loop.
 *
 * Run kinds (plan Slice 3): `input.kind === "SPIKE"` takes the spike path
 * (spike prompt, critical `syncSpikeArtifacts`, terminal DEMO_READY). Any
 * other value, including the `undefined` carried by histories started
 * before spikes existed, takes the implement path, which schedules exactly
 * the same commands as before.
 *
 * Replay fixture note: `test:replay` validates against histories under
 * `__tests__/__fixtures__/histories/<WorkflowType>/` populated by
 * `fetch:replay-histories`. No `codingRunWorkflow` history exists in the
 * local Temporal server (this branch's dev DB never ran one), so the
 * implement-path fixture could not be captured here; capture one from an
 * environment that has run an implement session before relying on local
 * replay, and let CI replay validation cover the PR meanwhile.
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
import { type CodingRunPlan, selectCodingRunPlan } from "./coding-run-plan";

const {
	updateCodingRunStatusActivity,
	addCodingRunEventActivity,
	buildImplementationPrompt,
	buildSpikePrompt,
	sendExecutionPrompt: sendExecutionPromptDefault,
	pollExecutionStatus: pollExecutionStatusDefault,
	syncCodingRunArtifacts: syncCodingRunArtifactsDefault,
	syncSpikeArtifacts,
	cancelExecutionSession: cancelExecutionSessionDefault,
} = proxyActivities<typeof codingRunActivities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Session creation may perform a first-time git clone + worktree setup on the
// Fabric Agents server, so give it a longer startToCloseTimeout.
const { createExecutionSession: createLegacyExecutionSession } =
	proxyActivities<typeof codingRunActivities>({
		startToCloseTimeout: "5 minutes",
		retry: {
			initialInterval: "2s",
			backoffCoefficient: 2,
			maximumInterval: "30s",
			maximumAttempts: 3,
		},
	});

// One attempt preserves the distinction between an unsent request and an ambiguous
// earlier attempt. Only the undeployed lifecycle-v2 branch uses these options.
const nativeCreation = proxyActivities<typeof codingRunActivities>({
	startToCloseTimeout: "5 minutes",
	retry: { maximumAttempts: 1 },
});

// Session lifecycle cleanup — runs from the workflow's finally block
// inside `CancellationScope.nonCancellable` so it fires on every exit
// path (success, error, poll-exhausted, cancel, exception, timeout).
const { cleanupWeaveResourcesActivity: cleanupWeaveResourcesDefault } =
	proxyActivities<typeof allActivities>({
		startToCloseTimeout: "2 minutes",
		retry: {
			initialInterval: "1s",
			backoffCoefficient: 2,
			maximumInterval: "10s",
			maximumAttempts: 3,
		},
	});

const { pollExecutionStatus: pollStatusDefault } = proxyActivities<
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

const lifecycleActivities = proxyActivities<typeof codingRunActivities>({
	startToCloseTimeout: "2 minutes",
	retry: { maximumAttempts: 3 },
});
const remoteActivities = proxyActivities<typeof codingRunActivities>({
	startToCloseTimeout: "2 minutes",
	retry: { maximumAttempts: 3 },
});
const remoteCreation = proxyActivities<typeof codingRunActivities>({
	startToCloseTimeout: "5 minutes",
	retry: { maximumAttempts: 1 },
});
const remotePoll = proxyActivities<typeof codingRunActivities>({
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 2 },
});
const remoteCleanup = proxyActivities<typeof allActivities>({
	startToCloseTimeout: "2 minutes",
	retry: { maximumAttempts: 3 },
});
const sendExecutionPrompt: typeof codingRunActivities.sendExecutionPrompt = (
	...args
) =>
	workflowInfo().workflowType === "remoteCodingRunWorkflow"
		? remoteActivities.sendRemoteExecutionPrompt(...args)
		: sendExecutionPromptDefault(...args);
const pollExecutionStatus: typeof codingRunActivities.pollExecutionStatus = (
	...args
) =>
	workflowInfo().workflowType === "remoteCodingRunWorkflow"
		? remoteActivities.pollRemoteExecutionStatus(...args)
		: pollExecutionStatusDefault(...args);
const syncCodingRunArtifacts: typeof codingRunActivities.syncCodingRunArtifacts =
	(...args) =>
		workflowInfo().workflowType === "remoteCodingRunWorkflow"
			? remoteActivities.syncRemoteCodingRunArtifacts(...args)
			: syncCodingRunArtifactsDefault(...args);
const cancelExecutionSession: typeof codingRunActivities.cancelExecutionSession =
	(...args) =>
		workflowInfo().workflowType === "remoteCodingRunWorkflow"
			? remoteActivities.cancelRemoteExecutionSession(...args)
			: cancelExecutionSessionDefault(...args);
const pollStatus: typeof codingRunActivities.pollExecutionStatus = (...args) =>
	workflowInfo().workflowType === "remoteCodingRunWorkflow"
		? remotePoll.pollRemoteExecutionStatus(...args)
		: pollStatusDefault(...args);
const cleanupWeaveResourcesActivity: typeof allActivities.cleanupWeaveResourcesActivity =
	(...args) =>
		workflowInfo().workflowType === "remoteCodingRunWorkflow"
			? remoteCleanup.cleanupRemoteWeaveResourcesActivity(...args)
			: cleanupWeaveResourcesDefault(...args);

const createExecutionSession: typeof codingRunActivities.createExecutionSession =
	(input) =>
		workflowInfo().workflowType === "remoteCodingRunWorkflow"
			? remoteCreation.createRemoteExecutionSession(input)
			: nativeCreation.createExecutionSession(input);

/** A distinct export prevents workers predating remote targeting from executing this run. */
export async function remoteCodingRunWorkflow(
	input: CodingRunWorkflowInput,
): Promise<CodingRunWorkflowOutput> {
	return codingRunWorkflow(input);
}

export const cancelCodingRunSignal = defineSignal("cancelCodingRun");
export const codingRunStatusQuery =
	defineQuery<CodingRunWorkflowStatus>("codingRunStatus");
export const providerCompleteSignal =
	defineSignal<[ProviderCompletePayload]>("providerComplete");

export interface CodingRunWorkflowInput {
	providerMetadata?: unknown;
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
	/**
	 * Run kind (plan Slice 3). Absent on histories started before spikes
	 * existed; anything but "SPIKE" takes the implement path unchanged.
	 */
	kind?: "IMPLEMENT" | "SPIKE";
	/** Required for SPIKE runs. */
	spikeQuestion?: string;
	/** Optional Fabric Agents backend connection slug */
	llmConnection?: string;
	/** Operator-selected rollout setting captured when the workflow starts. */
	fabricAgentsBridgeEnabled?: boolean;
	/** Optional model identifier override */
	model?: string;
	/** Optional target machine / host identifier */
	targetMachine?: string;
}

export interface CodingRunWorkflowOutput {
	codingRunId: string;
	status: "completed" | "demo_ready" | "failed" | "cancelled";
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
const LEGACY_SIGNAL_WAIT_SECONDS = 300; // 5 minutes for legacy histories
const BRIDGE_SIGNAL_WAIT_SECONDS = 15; // Poll fabric-agent-server every 15s while waking immediately on signals

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
	const plan = selectCodingRunPlan(input);
	const bridgePatch = patched("fabric-agents-execution-bridge-v1");
	const gatedCutover =
		bridgePatch && patched("fabric-agents-execution-cutover-v1");
	// Retain pre-gate bridge histories, and legacy histories without either marker.
	const useFabricAgentsBridge =
		bridgePatch &&
		(!gatedCutover || input.fabricAgentsBridgeEnabled === true);

	const durableLifecycle =
		useFabricAgentsBridge && patched("fabric-agents-lifecycle-v2");

	const updateStatus: typeof codingRunActivities.updateCodingRunStatusActivity =
		durableLifecycle
			? (input) =>
					lifecycleActivities.updateCodingRunStatusGuardedActivity({
						...input,
						workflowId,
						expectedStatuses: [
							"QUEUED",
							"STARTING",
							"RUNNING",
							"AWAITING_REVIEW",
							"PR_OPENED",
						],
					})
			: updateCodingRunStatusActivity;

	const syncArtifacts = durableLifecycle
		? remoteActivities.syncRemoteCodingRunArtifacts
		: syncCodingRunArtifacts;

	const state = {
		plan,
		useFabricAgentsBridge,
		updateStatus,
		syncArtifacts,
		providerMetadata: durableLifecycle
			? input.providerMetadata
			: (undefined as unknown),
		stopConfirmed: false,
		sessionCreationAttempted: false,
		cancelled: false,
		currentStatus: "STARTING",
		sessionId: null as string | null,
		pullRequestUrl: null as string | null,
		lastError: null as string | null,
		pollCount: 0,
		signalReceived: false,
		signalPayload: null as ProviderCompletePayload | null,
	};

	async function confirmNativeStop(): Promise<boolean> {
		if (!durableLifecycle) {
			return true;
		}
		if (state.stopConfirmed) {
			return true;
		}
		if (!state.sessionId && !state.sessionCreationAttempted) {
			return true;
		}
		try {
			if (!state.sessionId) {
				throw new Error("Session creation outcome is unknown");
			}
			const sessionId = state.sessionId;
			await CancellationScope.nonCancellable(() =>
				cancelExecutionSession({
					provider,
					sessionId,
					providerMetadata: state.providerMetadata,
				}),
			);
			state.stopConfirmed = true;
			return true;
		} catch (error) {
			await CancellationScope.nonCancellable(async () => {
				await lifecycleActivities.recordCodingRunRecoveryActivity({
					codingRunId,
					workflowId: workflowInfo().workflowId,
					organizationId: organizationId ?? null,
					eventType: "cancellation_unknown",
					payload: {
						message:
							error instanceof ActivityFailure &&
							error.cause instanceof ApplicationFailure &&
							error.cause.type === "NotFoundError"
								? "Cancellation activity is not registered; no stop request was sent. Check the original server before recovering the run."
								: "Remote shutdown requires reconciliation before another run can start",
					},
				});
			});
			return false;
		}
	}

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
		if (payload.error) {
			state.lastError = payload.error;
		}
	});

	setHandler(codingRunStatusQuery, () => ({
		codingRunId,
		status: state.currentStatus,
		sessionId: state.sessionId,
		...(state.providerMetadata
			? { providerMetadata: state.providerMetadata }
			: {}),
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
		await updateStatus({
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
			if (durableLifecycle && !(await confirmNativeStop())) {
				return {
					codingRunId,
					status: "failed",
					error: "Cancellation requires recovery",
				};
			}
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
				state.providerMetadata,
				durableLifecycle,
				state.stopConfirmed,
				organizationId,
			);
		}

		// Implement runs schedule exactly the same activity with the same
		// arguments as before spikes existed (replay safety).
		const prompt =
			plan.prompt === "spike"
				? await buildSpikePrompt({
						storyId,
						projectId,
						storyTaskId: input.storyTaskId,
						userId,
						organizationId,
						repositoryOwner,
						repositoryName,
						targetBranch,
						workingDirectory,
						codingRunId,
						spikeQuestion: input.spikeQuestion ?? "",
					})
				: await buildImplementationPrompt({
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
			if (durableLifecycle && !(await confirmNativeStop())) {
				return {
					codingRunId,
					status: "failed",
					error: "Cancellation requires recovery",
				};
			}
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
				state.providerMetadata,
				durableLifecycle,
				state.stopConfirmed,
				organizationId,
			);
		}

		state.sessionCreationAttempted = true;
		let sessionResult: Awaited<ReturnType<typeof createExecutionSession>>;
		for (let attempt = 0; ; attempt++) {
			try {
				sessionResult = await (durableLifecycle
					? createExecutionSession
					: createLegacyExecutionSession)({
					...(durableLifecycle && input.providerMetadata
						? { providerMetadata: input.providerMetadata }
						: {}),
					...(gatedCutover
						? { fabricAgentsBridgeEnabled: useFabricAgentsBridge }
						: {}),
					provider,
					repoOwner: repositoryOwner,
					repoName: repositoryName,
					projectName,
					organizationName,
					title: `Fabric: ${storyTitle}`,
					// The legacy protocol starts every session from the target branch;
					// spike prompts tell the agent to push `fabric-spike/<runId>`.
					branch: targetBranch,
					...(useFabricAgentsBridge && plan.prompt === "spike"
						? { headBranch: `fabric-spike/${codingRunId}` }
						: {}),
					userId,
					workingDirectory,
					promptText: prompt,
					codingRunId,
					workflowId,
					organizationId,
					projectId,
					...(useFabricAgentsBridge
						? {
								llmConnection: input.llmConnection,
								model: input.model,
								targetMachine: input.targetMachine,
							}
						: {}),
				});
				break;
			} catch (error) {
				// One activity attempt per call; only proof that no POST was sent permits retry.
				if (
					!durableLifecycle ||
					!isSessionNotCreated(error) ||
					state.cancelled ||
					attempt >= 2
				) {
					throw error;
				}
				await sleep(2 ** (attempt + 1) * 1000);
				if (state.cancelled) {
					throw error;
				}
			}
		}

		state.sessionId = sessionResult.sessionId;
		if (durableLifecycle) {
			state.providerMetadata = sessionResult.providerMetadata;
		}

		if (durableLifecycle && state.cancelled) {
			await updateStatus({
				codingRunId,
				status: "STARTING",
				data: {
					providerSessionId: state.sessionId,
					providerMetadata: sessionResult.providerMetadata,
				},
			});
			if (!(await confirmNativeStop())) {
				return {
					codingRunId,
					status: "failed",
					error: "Cancellation requires recovery",
				};
			}
			await updateStatus({
				codingRunId,
				status: "CANCELLED",
			});
			return { codingRunId, status: "cancelled" };
		}
		state.currentStatus = "RUNNING";
		await updateStatus({
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
			if (durableLifecycle && !(await confirmNativeStop())) {
				return {
					codingRunId,
					status: "failed",
					error: "Cancellation requires recovery",
				};
			}
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
				state.providerMetadata,
				durableLifecycle,
				state.stopConfirmed,
				organizationId,
			);
		}

		await sendExecutionPrompt({
			provider,
			sessionId: state.sessionId,
			...(state.providerMetadata
				? { providerMetadata: state.providerMetadata }
				: {}),
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
			if (durableLifecycle && !(await confirmNativeStop())) {
				return {
					codingRunId,
					status: "failed",
					error: "Cancellation requires recovery",
				};
			}
			return await handleCancellation(
				codingRunId,
				provider,
				state.sessionId,
				state.providerMetadata,
				durableLifecycle,
				state.stopConfirmed,
				organizationId,
			);
		}

		if (plan.sync === "spike") {
			// Spike path (plan Slice 3): no PR sync, artifact sync is critical,
			// terminal status is DEMO_READY. Nothing below this block runs for
			// spikes; nothing in this block runs for implement runs.
			return await finishSpikeRun(
				codingRunId,
				finalProviderStatus,
				state,
				{
					userId,
					organizationId,
					repositoryOwner,
					repositoryName,
				},
			);
		}

		if (state.sessionId) {
			try {
				const synced = await syncArtifacts({
					codingRunId,
					provider,
					sessionId: state.sessionId,
					...(state.providerMetadata
						? { providerMetadata: state.providerMetadata }
						: {}),
				});
				if (useFabricAgentsBridge && synced?.pullRequestUrl) {
					const hadPrBefore = Boolean(state.pullRequestUrl);
					state.pullRequestUrl = synced.pullRequestUrl;
					if (!hadPrBefore) {
						await addCodingRunEventActivity({
							codingRunId,
							eventType: "pr_opened",
							payload: {
								pullRequestUrl: synced.pullRequestUrl,
								branchName: synced.branchName,
							},
						});
					}
				}
			} catch (error) {
				if (durableLifecycle) {
					throw error;
				}
			}
		}

		const isBridgeRun =
			useFabricAgentsBridge && provider === "BACKGROUND_AGENTS";
		const hasSucceeded = isBridgeRun
			? finalProviderStatus === "completed"
			: finalProviderStatus === "completed" ||
				(finalProviderStatus === "active" &&
					Boolean(state.pullRequestUrl));

		if (hasSucceeded) {
			if (!(await confirmNativeStop())) {
				return {
					codingRunId,
					status: "failed",
					error: "Remote cleanup requires recovery",
				};
			}
			const finalFabricStatus = isBridgeRun
				? "COMPLETED"
				: state.currentStatus === "PR_OPENED"
					? "PR_OPENED"
					: state.currentStatus === "AWAITING_REVIEW"
						? "AWAITING_REVIEW"
						: "COMPLETED";
			state.currentStatus = finalFabricStatus;
			await updateStatus({
				codingRunId,
				status: finalFabricStatus,
				...(isBridgeRun && state.pullRequestUrl
					? {
							data: {
								pullRequestUrl: state.pullRequestUrl,
							},
						}
					: {}),
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

		if (
			finalProviderStatus === "stopped" ||
			(useFabricAgentsBridge && finalProviderStatus === "archived")
		) {
			if (!(await confirmNativeStop())) {
				return {
					codingRunId,
					status: "failed",
					error: "Cancellation requires recovery",
				};
			}
			state.currentStatus = "CANCELLED";
			await updateStatus({
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
			: state.lastError || "Coding agent session failed";

		if (!(await confirmNativeStop())) {
			return {
				codingRunId,
				status: "failed",
				error: "Remote cleanup requires recovery",
			};
		}
		state.currentStatus = "FAILED";
		await updateStatus({ codingRunId, status: "FAILED" });
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
		if (
			durableLifecycle &&
			!state.sessionId &&
			isSessionNotCreated(error)
		) {
			state.sessionCreationAttempted = false;
			const lastError = `Coding session was not created: ${error.cause.message}`;
			const status = state.cancelled ? "CANCELLED" : "FAILED";
			state.currentStatus = status;
			exitReason = state.cancelled ? "cancelled" : "failure";
			await updateStatus({
				codingRunId,
				status,
				data: { lastError },
			});
			await addCodingRunEventActivity({
				codingRunId,
				eventType: "session_not_created",
				payload: { error: lastError },
			});
			return {
				codingRunId,
				status: state.cancelled ? "cancelled" : "failed",
				error: lastError,
			};
		}
		const errorMsg =
			error instanceof ActivityFailure &&
			error.cause instanceof ApplicationFailure &&
			error.cause.type === "NotFoundError" &&
			state.sessionId
				? "A lifecycle activity is not registered; its request was not sent. The created session still requires confirmed cleanup."
				: extractErrorMessage(error);
		log.error("Coding run workflow error", {
			codingRunId,
			error: errorMsg,
		});
		if (!(await confirmNativeStop())) {
			return {
				codingRunId,
				status: "failed",
				error: "Remote cleanup requires recovery",
			};
		}
		state.currentStatus = "FAILED";
		// Leave `exitReason` as its default `"exception"` so the audit
		// log distinguishes unhandled throws from the deliberate
		// `"failure"` return above.
		try {
			await updateStatus({
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
				const cleanup = await cleanupWeaveResourcesActivity({
					sessionId: state.sessionId,
					...(state.providerMetadata
						? { providerMetadata: state.providerMetadata }
						: {}),
					provider,
					...(state.stopConfirmed
						? { stopAlreadyConfirmed: true }
						: {}),
					userId,
					organizationId: organizationId ?? null,
					codingRunId,
					exitReason,
					workflowId,
					runDurationMs: Date.now() - workflowStartedAtMs,
				});
				if (
					durableLifecycle &&
					!state.stopConfirmed &&
					state.sessionId &&
					cleanup &&
					!cleanup.destroyed
				) {
					await lifecycleActivities.recordCodingRunRecoveryActivity({
						codingRunId,
						workflowId: workflowInfo().workflowId,
						organizationId: organizationId ?? null,
						eventType: "cancellation_unknown",
						payload: {
							message:
								"Remote cleanup is unconfirmed; recover the existing session before starting another run",
						},
					});
				}
			});
		}
	}
}

async function processReceivedSignal(
	codingRunId: string,
	sessionId: string,
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
	state: {
		syncArtifacts?: typeof codingRunActivities.syncCodingRunArtifacts;
		updateStatus?: typeof codingRunActivities.updateCodingRunStatusActivity;
		plan: CodingRunPlan;
		currentStatus: string;
		providerMetadata?: unknown;
		pullRequestUrl: string | null;
		lastError: string | null;
		signalPayload: ProviderCompletePayload | null;
	},
): Promise<string> {
	if (!state.signalPayload) {
		return "completed";
	}
	if (state.signalPayload.error) {
		state.lastError = state.signalPayload.error;
	}
	await addCodingRunEventActivity({
		codingRunId,
		eventType: "provider_complete_signal",
		payload: {
			providerStatus: state.signalPayload.providerStatus,
			pullRequestUrl: state.signalPayload.pullRequestUrl,
			branchName: state.signalPayload.branchName,
			...(state.signalPayload.error
				? { error: state.signalPayload.error }
				: {}),
		},
	});

	if (
		state.plan.trackPullRequests &&
		state.signalPayload.pullRequestUrl &&
		state.currentStatus !== "PR_OPENED"
	) {
		state.pullRequestUrl = state.signalPayload.pullRequestUrl;
		state.currentStatus = "PR_OPENED";
		await (state.updateStatus ?? updateCodingRunStatusActivity)({
			codingRunId,
			status: "PR_OPENED",
		});
		await (state.syncArtifacts ?? syncCodingRunArtifacts)({
			codingRunId,
			provider,
			sessionId,
			...(state.providerMetadata
				? { providerMetadata: state.providerMetadata }
				: {}),
		});
	}

	return state.signalPayload.providerStatus;
}

async function runHybridLoop(
	codingRunId: string,
	sessionId: string,
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
	state: {
		syncArtifacts?: typeof codingRunActivities.syncCodingRunArtifacts;
		updateStatus?: typeof codingRunActivities.updateCodingRunStatusActivity;
		plan: CodingRunPlan;
		useFabricAgentsBridge: boolean;
		cancelled: boolean;
		currentStatus: string;
		providerMetadata?: unknown;
		pullRequestUrl: string | null;
		lastError: string | null;
		pollCount: number;
		signalReceived: boolean;
		signalPayload: ProviderCompletePayload | null;
	},
): Promise<string> {
	const waitSeconds = state.useFabricAgentsBridge
		? BRIDGE_SIGNAL_WAIT_SECONDS
		: LEGACY_SIGNAL_WAIT_SECONDS;
	const signalArrived = await condition(
		() => state.signalReceived || state.cancelled,
		`${waitSeconds} seconds`,
	);

	if (state.cancelled) {
		return "active";
	}

	if (signalArrived && state.signalPayload) {
		return await processReceivedSignal(
			codingRunId,
			sessionId,
			provider,
			state,
		);
	}

	log.info(
		"No providerComplete signal within window, falling back to polling",
		{ codingRunId, waitSeconds },
	);
	await addCodingRunEventActivity({
		codingRunId,
		eventType: "fallback_poll_status",
		payload: { reason: "signal_timeout", waitSeconds },
	});

	return await runPollLoop(codingRunId, sessionId, provider, state);
}

async function runPollLoop(
	codingRunId: string,
	sessionId: string,
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
	state: {
		syncArtifacts?: typeof codingRunActivities.syncCodingRunArtifacts;
		updateStatus?: typeof codingRunActivities.updateCodingRunStatusActivity;
		plan: CodingRunPlan;
		useFabricAgentsBridge: boolean;
		cancelled: boolean;
		currentStatus: string;
		providerMetadata?: unknown;
		pullRequestUrl: string | null;
		lastError: string | null;
		pollCount: number;
		signalReceived: boolean;
		signalPayload: ProviderCompletePayload | null;
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
			return state.useFabricAgentsBridge
				? await processReceivedSignal(
						codingRunId,
						sessionId,
						provider,
						state,
					)
				: "completed";
		}

		await sleep(`${POLL_INTERVAL_SECONDS} seconds`);
		state.pollCount = i + 1;
		if (state.cancelled) {
			return finalProviderStatus;
		}
		if (state.useFabricAgentsBridge && state.signalReceived) {
			log.info("Signal received after poll sleep, exiting", {
				codingRunId,
			});
			return await processReceivedSignal(
				codingRunId,
				sessionId,
				provider,
				state,
			);
		}

		let statusResult: Awaited<ReturnType<typeof pollExecutionStatus>>;
		try {
			statusResult = await pollStatus({
				provider,
				sessionId,
				...(state.providerMetadata
					? { providerMetadata: state.providerMetadata }
					: {}),
			});
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
		if (statusResult.error) {
			state.lastError = statusResult.error;
		}

		await addCodingRunEventActivity({
			codingRunId,
			eventType: "poll_status",
			payload: {
				providerStatus: statusResult.providerStatus,
				fabricStatus: statusResult.fabricStatus,
				branchName: statusResult.branchName,
				hasPr: !!statusResult.pullRequestUrl,
				pollCount: state.pollCount,
				...(statusResult.error ? { error: statusResult.error } : {}),
			},
		});

		// Spikes never mirror provider "completed" or PR statuses onto the
		// run: the only way to a terminal status is the artifact sync.
		// Under the Fabric Agents bridge patch, terminal provider statuses are
		// finalized after post-loop artifact synchronization so COMPLETED is
		// published exactly once after artifacts are synced.
		const isTerminalPollStatus = TERMINAL_PROVIDER_STATUSES.has(
			statusResult.providerStatus,
		);
		const mirrorsProviderStatus = state.useFabricAgentsBridge
			? !isTerminalPollStatus &&
				(state.plan.trackPullRequests ||
					statusResult.fabricStatus !== "PR_OPENED")
			: state.plan.trackPullRequests ||
				(statusResult.fabricStatus !== "COMPLETED" &&
					statusResult.fabricStatus !== "PR_OPENED");

		if (
			mirrorsProviderStatus &&
			statusResult.fabricStatus !== state.currentStatus &&
			!(
				statusResult.pullRequestUrl &&
				statusResult.fabricStatus === "PR_OPENED"
			)
		) {
			state.currentStatus = statusResult.fabricStatus;
			await (state.updateStatus ?? updateCodingRunStatusActivity)({
				codingRunId,
				status: statusResult.fabricStatus,
			});
		}

		if (
			state.plan.trackPullRequests &&
			statusResult.pullRequestUrl &&
			(state.useFabricAgentsBridge
				? !state.pullRequestUrl
				: state.currentStatus !== "PR_OPENED")
		) {
			state.pullRequestUrl = statusResult.pullRequestUrl;
			if (
				!state.useFabricAgentsBridge ||
				(statusResult.providerStatus !== "paused" &&
					statusResult.fabricStatus !== "AWAITING_REVIEW" &&
					state.currentStatus !== "AWAITING_REVIEW")
			) {
				state.currentStatus = "PR_OPENED";
			}
			await (state.syncArtifacts ?? syncCodingRunArtifacts)({
				codingRunId,
				provider,
				sessionId,
				...(state.providerMetadata
					? { providerMetadata: state.providerMetadata }
					: {}),
			});
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

/**
 * Spike terminal handling (plan Slice 3). Called only when the plan is a
 * spike, after the provider loop and the cancellation check.
 */
async function finishSpikeRun(
	codingRunId: string,
	finalProviderStatus: string,
	state: {
		syncArtifacts?: typeof codingRunActivities.syncCodingRunArtifacts;
		updateStatus?: typeof codingRunActivities.updateCodingRunStatusActivity;
		currentStatus: string;
		pollCount: number;
	},
	ctx: {
		userId: string;
		organizationId?: string;
		repositoryOwner: string;
		repositoryName: string;
	},
): Promise<CodingRunWorkflowOutput> {
	if (finalProviderStatus === "stopped") {
		state.currentStatus = "CANCELLED";
		await (state.updateStatus ?? updateCodingRunStatusActivity)({
			codingRunId,
			status: "CANCELLED",
		});
		return {
			codingRunId,
			status: "cancelled",
			error: "Session was stopped by the provider",
		};
	}

	if (finalProviderStatus !== "completed") {
		const isTimeout = !TERMINAL_PROVIDER_STATUSES.has(finalProviderStatus);
		const errorMessage = isTimeout
			? `Spike run timed out after ${(MAX_POLL_ITERATIONS * POLL_INTERVAL_SECONDS) / 60} minutes`
			: "Spike agent session failed";
		state.currentStatus = "FAILED";
		await (state.updateStatus ?? updateCodingRunStatusActivity)({
			codingRunId,
			status: "FAILED",
		});
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "workflow_failed",
			payload: {
				error: errorMessage,
				finalProviderStatus,
				pollCount: state.pollCount,
			},
		});
		return { codingRunId, status: "failed", error: errorMessage };
	}

	// Critical: the run is DEMO_READY only once the activity has created
	// the frame. The activity itself marks the run FAILED before throwing;
	// the status write here covers the case where it never got that far.
	let synced: Awaited<ReturnType<typeof syncSpikeArtifacts>>;
	try {
		synced = await syncSpikeArtifacts({
			codingRunId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			repositoryOwner: ctx.repositoryOwner,
			repositoryName: ctx.repositoryName,
		});
	} catch (error) {
		const errorMessage = extractErrorMessage(error);
		state.currentStatus = "FAILED";
		await (state.updateStatus ?? updateCodingRunStatusActivity)({
			codingRunId,
			status: "FAILED",
		});
		await addCodingRunEventActivity({
			codingRunId,
			eventType: "workflow_failed",
			payload: {
				error: errorMessage,
				reason: "spike_sync_failed",
				pollCount: state.pollCount,
			},
		});
		return { codingRunId, status: "failed", error: errorMessage };
	}

	state.currentStatus = "DEMO_READY";
	await addCodingRunEventActivity({
		codingRunId,
		eventType: "workflow_completed",
		payload: {
			status: "DEMO_READY",
			spikeBranch: synced.spikeBranch,
			demoFrameId: synced.demoFrameId,
			pollCount: state.pollCount,
		},
	});
	return { codingRunId, status: "demo_ready" };
}

async function handleCancellation(
	codingRunId: string,
	provider: "BACKGROUND_AGENTS" | "KANBAN_LOCAL",
	sessionId: string | null,
	providerMetadata?: unknown,
	strictCancellation = false,
	stopAlreadyConfirmed = false,
	organizationId?: string,
): Promise<CodingRunWorkflowOutput> {
	const updateStatus: typeof codingRunActivities.updateCodingRunStatusActivity =
		strictCancellation
			? (input) =>
					lifecycleActivities.updateCodingRunStatusGuardedActivity({
						...input,
						workflowId: workflowInfo().workflowId,
						expectedStatuses: [
							"QUEUED",
							"STARTING",
							"RUNNING",
							"AWAITING_REVIEW",
							"PR_OPENED",
						],
					})
			: updateCodingRunStatusActivity;

	log.info("Cancelling coding run", { codingRunId, sessionId });
	if (sessionId && !stopAlreadyConfirmed) {
		try {
			await cancelExecutionSession({
				provider,
				sessionId,
				...(providerMetadata
					? { providerMetadata: providerMetadata }
					: {}),
			});
		} catch (e) {
			if (strictCancellation) {
				await lifecycleActivities.recordCodingRunRecoveryActivity({
					codingRunId,
					workflowId: workflowInfo().workflowId,
					organizationId: organizationId ?? null,
					eventType: "cancellation_unknown",
					payload: {
						message:
							"Cancellation has not been confirmed; inspect the existing session",
					},
				});
				return {
					codingRunId,
					status: "failed",
					error: "Cancellation requires recovery",
				};
			}
			log.warn("Failed to cancel execution session", {
				codingRunId,
				error: extractErrorMessage(e),
			});
		}
	}
	try {
		await updateStatus({
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

/** The installed SDK emits NotFoundError before invoking an unregistered activity body. */
function isSessionNotCreated(
	error: unknown,
): error is ActivityFailure & { cause: ApplicationFailure } {
	return (
		error instanceof ActivityFailure &&
		error.cause instanceof ApplicationFailure &&
		["CODING_SESSION_NOT_CREATED", "NotFoundError"].includes(
			error.cause.type ?? "",
		)
	);
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

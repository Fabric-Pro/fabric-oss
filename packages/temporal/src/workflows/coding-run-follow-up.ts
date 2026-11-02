import {
	ActivityFailure,
	ApplicationFailure,
	CancellationScope,
	condition,
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities/coding-run";
import type { CodingRunFollowUpInput } from "../activities/coding-run/follow-up";

const {
	deliverCodingRunFollowUp,
	pollExecutionStatus,
	cancelExecutionSession,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 seconds",
	retry: { initialInterval: "1s", maximumAttempts: 3 },
});
export const codingFollowUpReceipt = defineQuery<{ messageId: string } | null>(
	"codingFollowUpReceipt",
);
const cancel = defineSignal("cancelCodingRun");

/** Observe another turn of the existing native session; never create a replacement. */
export async function codingRunFollowUpWorkflow(
	input: CodingRunFollowUpInput,
): Promise<void> {
	let cancelled = false;
	let terminalStatus: "COMPLETED" | "FAILED" | "CANCELLED" = "FAILED";
	let receipt: { messageId: string } | null = null;
	setHandler(cancel, () => {
		cancelled = true;
	});
	setHandler(codingFollowUpReceipt, () => receipt);
	const remote = (
		input.providerMetadata as
			| { executionTarget?: { connectionId?: string } }
			| undefined
	)?.executionTarget?.connectionId;
	const remoteActivities = proxyActivities<typeof activities>({
		startToCloseTimeout: "30 seconds",
		retry: { initialInterval: "1s", maximumAttempts: 3 },
	});
	const pollStatus = remote
		? remoteActivities.pollRemoteExecutionStatus
		: pollExecutionStatus;
	const syncArtifacts = remoteActivities.syncRemoteCodingRunArtifacts;
	const cancelSession = remote
		? remoteActivities.cancelRemoteExecutionSession
		: cancelExecutionSession;
	const updateStatus: typeof activities.updateCodingRunStatusActivity = (
		value,
	) =>
		remoteActivities.updateCodingRunStatusGuardedActivity({
			...value,
			workflowId: workflowInfo().workflowId,
			expectedStatuses: [
				"QUEUED",
				"STARTING",
				"RUNNING",
				"AWAITING_REVIEW",
				"PR_OPENED",
			],
		});
	const recordRecovery = (
		eventType: "cancellation_unknown" | "continuation_recovery_required",
		payload: Record<string, unknown>,
	) =>
		remoteActivities.recordCodingRunRecoveryActivity({
			codingRunId: input.codingRunId,
			workflowId: workflowInfo().workflowId,
			organizationId: input.organizationId,
			eventType,
			payload,
		});

	const session = {
		provider: "BACKGROUND_AGENTS" as const,
		sessionId: input.sessionId,
		providerMetadata: input.providerMetadata,
	};
	try {
		if (!cancelled) {
			receipt = await deliverCodingRunFollowUp(input);
		}
		const observationDeadline = Date.now() + 90 * 60_000;
		while (Date.now() < observationDeadline) {
			await condition(
				() => cancelled,
				Math.min(15_000, observationDeadline - Date.now()),
			);
			if (cancelled) {
				terminalStatus = "CANCELLED";
				return;
			}
			if (Date.now() >= observationDeadline) {
				break;
			}
			let status: Awaited<ReturnType<typeof pollExecutionStatus>>;
			try {
				status = await pollStatus(session);
			} catch (error) {
				if (
					error instanceof ActivityFailure &&
					error.cause instanceof ApplicationFailure &&
					error.cause.nonRetryable &&
					error.cause.type === "SESSION_NOT_FOUND"
				) {
					throw error;
				}
				log.warn(
					"Coding follow-up poll failed; continuing observation",
					{ codingRunId: input.codingRunId },
				);
				continue;
			}
			if (cancelled) {
				terminalStatus = "CANCELLED";
				return;
			}
			if (Date.now() >= observationDeadline) {
				break;
			}
			await syncArtifacts({
				...session,
				codingRunId: input.codingRunId,
			});
			if (cancelled) {
				terminalStatus = "CANCELLED";
				return;
			}
			if (Date.now() >= observationDeadline) {
				break;
			}
			const terminal = [
				"completed",
				"failed",
				"stopped",
				"archived",
			].includes(status.providerStatus);
			if (terminal) {
				terminalStatus =
					status.providerStatus === "completed"
						? "COMPLETED"
						: status.providerStatus === "failed"
							? "FAILED"
							: "CANCELLED";
				return;
			}
			await updateStatus({
				codingRunId: input.codingRunId,
				status:
					status.providerStatus === "paused"
						? "AWAITING_REVIEW"
						: "RUNNING",
			});
		}
		throw new Error(
			"Coding follow-up observation timed out; inspect the existing session",
		);
	} catch (error) {
		await recordRecovery("continuation_recovery_required", {
			message:
				error instanceof Error
					? error.message
					: "Continuation requires recovery",
			promptId: input.promptId,
		});
		// The finally block releases the row only after confirmed remote shutdown.
		throw error;
	} finally {
		await CancellationScope.nonCancellable(async () => {
			try {
				await cancelSession(session);
			} catch {
				await recordRecovery("cancellation_unknown", {
					promptId: input.promptId,
					message:
						"Owned work has not confirmed shutdown; inspect the existing session",
				});
				return;
			}
			await updateStatus({
				codingRunId: input.codingRunId,
				status: cancelled ? "CANCELLED" : terminalStatus,
			});
		});
	}
}

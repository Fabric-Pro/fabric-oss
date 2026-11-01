import {
	CancellationScope,
	condition,
	defineQuery,
	defineSignal,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as activities from "../activities/coding-run";
import type { CodingRunFollowUpInput } from "../activities/coding-run/follow-up";

const {
	deliverCodingRunFollowUp,
	pollExecutionStatus,
	syncCodingRunArtifacts,
	updateCodingRunStatusActivity,
	addCodingRunEventActivity,
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
	const session = {
		provider: "BACKGROUND_AGENTS" as const,
		sessionId: input.sessionId,
		providerMetadata: input.providerMetadata,
	};
	try {
		if (!cancelled) {
			receipt = await deliverCodingRunFollowUp(input);
		}
		for (let poll = 0; poll < 360; poll++) {
			await condition(() => cancelled, "15 seconds");
			if (cancelled) {
				terminalStatus = "CANCELLED";
				return;
			}
			const status = await pollExecutionStatus(session);
			if (cancelled) {
				terminalStatus = "CANCELLED";
				return;
			}
			await syncCodingRunArtifacts({
				...session,
				codingRunId: input.codingRunId,
			});
			if (cancelled) {
				terminalStatus = "CANCELLED";
				return;
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
			await updateCodingRunStatusActivity({
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
		await addCodingRunEventActivity({
			codingRunId: input.codingRunId,
			eventType: "continuation_recovery_required",
			payload: {
				message:
					error instanceof Error
						? error.message
						: "Continuation requires recovery",
				promptId: input.promptId,
			},
		});
		// Keep the row active: a timeout or ambiguous send is not proof that remote work stopped.
		throw error;
	} finally {
		await CancellationScope.nonCancellable(async () => {
			try {
				await cancelExecutionSession(session);
			} catch {
				await updateCodingRunStatusActivity({
					codingRunId: input.codingRunId,
					status: "AWAITING_REVIEW",
				});
				await addCodingRunEventActivity({
					codingRunId: input.codingRunId,
					eventType: "cancellation_unknown",
					payload: {
						promptId: input.promptId,
						message:
							"Owned work has not confirmed shutdown; inspect the existing session",
					},
				});
				return;
			}
			await updateCodingRunStatusActivity({
				codingRunId: input.codingRunId,
				status: cancelled ? "CANCELLED" : terminalStatus,
			});
		});
	}
}

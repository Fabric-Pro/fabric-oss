import { patched, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type * as receiptActivities from "../../activities/agent-execution-native-receipt";
import {
	NATIVE_AGENT_RECEIPT_PATCH,
	type NativeAgentAdmission,
} from "../../lib/agent-execution-native-protocol";
import { startRunQualityObserver } from "./start-run-quality";

const { registerNativeAgentExecutionReceipt, completeNativeAgentExecution } =
	proxyActivities<typeof receiptActivities>({
		startToCloseTimeout: "1 minute",
		heartbeatTimeout: "15 seconds",
		retry: { initialInterval: "1s", maximumInterval: "30s" },
	});

type NativeInput = {
	nativeAdmission?: NativeAgentAdmission;
	executionId: string;
	deploymentId: string;
	instanceId: string;
	userId: string;
	organizationId?: string;
};

function receiptInput(
	input: NativeInput,
): receiptActivities.RegisterNativeAgentReceiptInput {
	if (!input.nativeAdmission) {
		throw new Error(
			"Native execution requires a server admission descriptor",
		);
	}
	const info = workflowInfo();
	return {
		...input,
		nativeAdmission: input.nativeAdmission,
		workflowId: info.workflowId,
		runId: info.runId,
		workflowType: info.workflowType,
		admissionMemo: info.memo?.fabricAgentAdmission,
	};
}

/** Missing input marker leaves legacy/supervisor histories command-for-command unchanged. */
export async function registerNativeAgentReceipt(
	input: NativeInput,
): Promise<void> {
	if (!input.nativeAdmission || !patched(NATIVE_AGENT_RECEIPT_PATCH)) {
		return;
	}
	await registerNativeAgentExecutionReceipt(receiptInput(input));
	if (input.organizationId && patched("native-run-quality-observer-v1")) {
		await startRunQualityObserver({
			targetType: "AGENT",
			targetId: input.instanceId,
			executionId: input.nativeAdmission.executionRowId,
			userId: input.userId,
			organizationId: input.organizationId,
		});
	}
}

/** Unlimited native projection retries cannot re-enter the agent loop. */
export async function persistNativeAgentCompletion(
	input: NativeInput,
	completion: Omit<
		receiptActivities.CompleteNativeAgentExecutionInput,
		"receipt" | "completedAt"
	>,
): Promise<void> {
	await completeNativeAgentExecution({
		...completion,
		receipt: receiptInput(input),
		completedAt: new Date().toISOString(),
	});
}

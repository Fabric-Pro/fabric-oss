import { proxyActivities } from "@temporalio/workflow";
import type { recoverAgentExecutionReceipts as Recover } from "../activities/agent-execution-receipt-recovery";

const { recoverAgentExecutionReceipts } = proxyActivities<{
	recoverAgentExecutionReceipts: typeof Recover;
}>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "15 seconds",
	retry: { maximumAttempts: 1 },
});

/** A bounded pass; later schedule ticks retry unresolved receipts without replaying work. */
export async function agentExecutionReceiptRecoveryWorkflow() {
	return recoverAgentExecutionReceipts();
}

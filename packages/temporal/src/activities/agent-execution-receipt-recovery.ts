import {
	claimAgentExecutionReceiptObservation,
	listAgentExecutionReceiptCandidates,
	readAgentExecutionAdmission,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { dispatchAdmittedAgentExecution } from "../lib/agent-execution-dispatch";
import { withHeartbeatTicker } from "./lib/activity-liveness";

export type AgentReceiptRecoverySummary = {
	scanned: number;
	recovered: number;
	unresolved: number;
	refused: number;
	skipped: number;
};

/** Receipt repair only: never replay agent work, create executions or reserve allowance. */
export async function recoverAgentExecutionReceipts(): Promise<AgentReceiptRecoverySummary> {
	return withHeartbeatTicker(observeReceipts, {
		intervalMs: 5_000,
		details: "agent-receipt-recovery",
	});
}

async function observeReceipts(): Promise<AgentReceiptRecoverySummary> {
	const now = new Date();
	const rows = await listAgentExecutionReceiptCandidates({
		limit: 25,
		before: new Date(now.getTime() - 60_000),
	});
	const summary: AgentReceiptRecoverySummary = {
		scanned: rows.length,
		recovered: 0,
		unresolved: 0,
		refused: 0,
		skipped: 0,
	};
	for (const row of rows) {
		heartbeat({ ...summary });
		let stage: "observation_claim" | "authorization_or_storage" =
			"observation_claim";
		try {
			if (
				!(await claimAgentExecutionReceiptObservation(row, new Date()))
			) {
				summary.skipped++;
				continue;
			}
			stage = "authorization_or_storage";
			const admission = readAgentExecutionAdmission(row);
			if (
				!admission ||
				!row.organizationId ||
				row.deployment.userId !== row.userId ||
				row.deployment.organizationId !== row.organizationId ||
				row.deployment.instanceId !== admission.dispatch.instanceId
			) {
				summary.refused++;
				continue;
			}
			const result = await dispatchAdmittedAgentExecution(row, {
				observeOnly: true,
			});
			if (result.confirmed) {
				summary.recovered++;
			} else if (result.revoked || result.recoverable === false) {
				summary.refused++;
			} else {
				summary.unresolved++;
				if (result.reason && result.reason !== "workflow_unconfirmed") {
					logger.warn(
						{
							event: "agent.receipt_recovery.failed",
							stage: result.reason,
						},
						"Saved-agent receipt observation will retry on a later pass",
					);
				}
			}
		} catch {
			// No model payload, source content or raw provider error enters logs/metadata.
			summary.skipped++;
			logger.warn(
				{ event: "agent.receipt_recovery.failed", stage },
				"Saved-agent receipt could not be inspected; retrying on a later pass",
			);
		}
	}
	return summary;
}

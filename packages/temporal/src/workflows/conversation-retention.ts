/**
 * Conversation / Agent-History Retention Workflow
 *
 * Scheduled daily (see `packages/temporal/src/schedules.ts`). Purges `ai_chat`
 * and `agent_conversation` rows untouched for longer than
 * `FABRIC_CONVERSATION_RETENTION_DAYS` by delegating to
 * `purgeExpiredConversationsActivity`. The workflow contains zero side effects
 * — no env reads, no `Date.now()`, no Prisma calls — so replay stays
 * deterministic (every state change happens inside the activity).
 *
 * SOC 2 C1.2, which names this data explicitly: "including Fabric
 * conversation/agent history per the agreed retention schedule".
 *
 * Registration: the schedule `conversation-retention` is OPT-IN — it registers
 * only when `FABRIC_CONVERSATION_RETENTION_ENABLED === "true"`, and the
 * activity additionally no-ops unless `FABRIC_CONVERSATION_RETENTION_DAYS` is
 * set to a positive value. Both gates are deliberate: the retention period for
 * conversation history is a business commitment, so nothing is destroyed until
 * somebody chooses a number. The schedule id is stable, so re-registration is
 * idempotent.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/conversation-retention";

const { purgeExpiredConversationsActivity } = proxyActivities<
	typeof activities
>({
	// Two tables, each up to a 1,000-batch cap — allow more headroom than the
	// single-table request-span purge.
	startToCloseTimeout: "20 minutes",
	retry: {
		// Idempotent in effect — a retry after partial progress just deletes
		// whatever still falls past the cutoff.
		initialInterval: "30 seconds",
		maximumInterval: "5 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function conversationRetentionWorkflow(): Promise<{
	deletedCount: number;
	cutoffAt: string;
	retentionDays: number;
	enabled: boolean;
	hitSafetyCap: boolean;
}> {
	const result = await purgeExpiredConversationsActivity();
	return {
		deletedCount: result.deletedCount,
		cutoffAt: result.cutoffAt,
		retentionDays: result.retentionDays,
		enabled: result.enabled,
		hitSafetyCap: result.hitSafetyCap,
	};
}

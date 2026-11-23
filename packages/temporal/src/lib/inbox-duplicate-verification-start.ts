/**
 * Starts the Proposal Inbox's duplicate verifier in the background
 * (`verifyInboxDuplicatesWorkflow`) for the candidate pairs the inbox's
 * duplicate check found without a current verdict.
 *
 * Kept free of workflow imports so `@repo/api` can call it. One run per
 * project: a start while a run is in progress joins it (USE_EXISTING), and
 * the inbox's next check asks again for whatever is still unverified.
 *
 * Never throws: failing to start is logged, and the pairs stay unverified
 * (and unflagged) until a later check starts a run.
 */

import { runWithDefaultAiJobType } from "@repo/ai/lib/job-context";
import type { InboxDuplicatePair } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "../client";

const TASK_QUEUE = "ai-chat";

const LOG_PREFIX = "[Inbox Dup Verify]";

interface StartInboxDuplicateVerificationParams {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	pairs: InboxDuplicatePair[];
}

export async function startInboxDuplicateVerification(
	params: StartInboxDuplicateVerificationParams,
): Promise<void> {
	if (params.pairs.length === 0) {
		return;
	}
	try {
		const client = await getTemporalClient();
		// The verifier may run on the organization's shared ChatGPT plans,
		// like the roadmap's automatic duplicate check.
		await runWithDefaultAiJobType("duplicate-detection", () =>
			client.workflow.start("verifyInboxDuplicatesWorkflow", {
				taskQueue: TASK_QUEUE,
				workflowId: `inbox-dup-verify-${params.projectId}`,
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [
					{
						projectId: params.projectId,
						userId: params.userId,
						organizationId: params.organizationId ?? null,
						pairs: params.pairs,
					},
				],
			}),
		);
	} catch (err) {
		logger.warn(`${LOG_PREFIX} could not start verification`, {
			projectId: params.projectId,
			pairs: params.pairs.length,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

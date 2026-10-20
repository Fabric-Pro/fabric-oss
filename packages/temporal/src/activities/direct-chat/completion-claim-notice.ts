/**
 * The Direct engine's unbacked-completion check: a reply from a turn that
 * called no tool, while tools were bound, is asked whether it claims an
 * action was done; if it does, the reply ends with a notice saying nothing
 * was done.
 *
 * The Orchestrator gives such a turn a corrective round whose answer replaces
 * the claim. Direct cannot: its stream route only ever appends to the text it
 * has shown, and it has no turn ledger to admit a second generation. So the
 * claim stays visible and is corrected beneath it, in the reply the user sees
 * and in the history later turns read. The judge is the same
 * `checkCompletionClaimActivity`, called in-process.
 */

import { logger } from "@repo/logs";
import { checkCompletionClaimActivity } from "../orchestrator/execution/check-completion-claim";

/**
 * Shown under a reply that claims an action no tool call backs. Product copy,
 * not model instructions: it tells the user what did not happen.
 */
export const UNBACKED_CLAIM_NOTICE =
	"_Note: no tool ran while this reply was written, so nothing it describes was created, scheduled, run or changed just now, and nothing was checked. Ask again to have it done._";

export async function withUnbackedClaimNotice(params: {
	reply: string;
	userRequest: string;
	toolCallCount: number;
	toolsEnabled: boolean;
	/** A spoken reply would read the notice aloud; voice turns are left alone. */
	voiceTurn: boolean;
	userId: string;
	organizationId?: string;
	projectId?: string;
	conversationId?: string;
}): Promise<string> {
	if (
		params.toolCallCount > 0 ||
		!params.toolsEnabled ||
		params.voiceTurn ||
		params.reply.trim().length === 0
	) {
		return params.reply;
	}
	// The reply is already written and shown; a check that cannot run must
	// not turn it into a failed turn.
	try {
		const { unbackedClaim } = await checkCompletionClaimActivity({
			userId: params.userId,
			organizationId: params.organizationId,
			projectId: params.projectId,
			conversationId: params.conversationId,
			userRequest: params.userRequest,
			reply: params.reply,
		});
		return unbackedClaim
			? `${params.reply}\n\n${UNBACKED_CLAIM_NOTICE}`
			: params.reply;
	} catch (error) {
		logger.warn(
			"[DirectChat] completion claim check failed; reply stands",
			{
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return params.reply;
	}
}

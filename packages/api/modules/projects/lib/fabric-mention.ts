import { ORPCError } from "@orpc/client";
import { getTemporalClient } from "@repo/temporal";
import { checkRateLimit } from "../../../lib/rate-limit";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

const FABRIC_MENTION_REGEX = /(^|\s)@fabric(?=$|\s|[:,.!?])[:,]?\s*(.*)$/i;
const FABRIC_MENTION_RATE_LIMIT = 30;
const FABRIC_MENTION_RATE_WINDOW_MS = 60_000;

export function extractFabricMention(content: string): string | null {
	const match = content.match(FABRIC_MENTION_REGEX);
	return match?.[2]?.trim() ?? null;
}

/**
 * Throws TOO_MANY_REQUESTS if the (projectId, userId) pair has exceeded the
 * @fabric mention quota in the current window. Should be called BEFORE
 * persisting the comment so quota-blocked users don't end up with a comment
 * whose agent reply was never queued.
 */
export async function assertFabricMentionRateLimit(
	projectId: string,
	userId: string,
): Promise<void> {
	const key = `fabric-mention:${projectId}:${userId}`;
	const result = await checkRateLimit(
		key,
		FABRIC_MENTION_RATE_LIMIT,
		FABRIC_MENTION_RATE_WINDOW_MS,
	);
	if (!result.allowed) {
		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: `Fabric mention rate limit exceeded. Try again in ${result.resetInSeconds}s.`,
		});
	}
}

export async function startFabricMentionReplyWorkflow(input: {
	targetType: "story" | "task";
	targetId: string;
	commentId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<string> {
	const workflowId = `fabric-mention-reply-${input.commentId}`;
	const client = await getTemporalClient();
	await client.workflow.start(
		"fabricMentionReplyWorkflow",
		withCorrelationMemo({
			taskQueue: "fabric-worker",
			workflowId,
			args: [
				{
					workflowId,
					targetType: input.targetType,
					targetId: input.targetId,
					commentId: input.commentId,
					userId: input.userId,
					organizationId: input.organizationId ?? undefined,
				},
			],
		}),
	);
	return workflowId;
}

/**
 * The shared memory of a spent ChatGPT plan window, per plan source
 * (Fizzy #2770): a member's own plan (`USER`, keyed by userId) or an
 * organization account (`ORG`, keyed by account id). Web and worker processes
 * read and write the same rows, so one refusal stops every process asking.
 *
 * The table has no organizationId. Callers pass only sources they already
 * resolved — the session's own userId, or account ids read through the
 * organization-filtered queries in `chatgpt-plan-org-accounts.ts`.
 */

import { db } from "../client";
import type {
	ChatGptPlanSourceKind,
	ChatGptPlanSourceState,
} from "../generated/client";
import { withChatGptPlanCredentialFence } from "./lib/chatgpt-plan-credential-fence";

export type { ChatGptPlanSourceKind, ChatGptPlanSourceState };

export interface ChatGptPlanSourceKey {
	sourceKind: ChatGptPlanSourceKind;
	sourceId: string;
}

export function getChatGptPlanSourceStates(
	sourceKind: ChatGptPlanSourceKind,
	sourceIds: string[],
): Promise<ChatGptPlanSourceState[]> {
	if (sourceIds.length === 0) {
		return Promise.resolve([]);
	}
	return db.chatGptPlanSourceState.findMany({
		where: { sourceKind, sourceId: { in: sourceIds } },
	});
}

export interface ChatGptPlanSourceExhaustion extends ChatGptPlanSourceKey {
	openUntil: Date;
	resetAt: Date | null;
	consecutiveUnknownResets: number;
	exhaustedAt: Date;
	/**
	 * The sign-in whose call was refused (Fizzy #3037); null accepts the
	 * source's current one, for a report that does not say.
	 */
	credentialFingerprint: string | null;
}

/**
 * Records the refusal, unless the source's sign-in changed since the refused
 * call read its token. True when it was recorded.
 */
export function recordChatGptPlanSourceExhausted(
	input: ChatGptPlanSourceExhaustion,
): Promise<boolean> {
	const {
		sourceKind,
		sourceId,
		exhaustedAt,
		credentialFingerprint,
		...fields
	} = input;
	const data = { ...fields, lastExhaustedAt: exhaustedAt };
	return withChatGptPlanCredentialFence(
		{ sourceKind, sourceId },
		credentialFingerprint,
		(tx) =>
			tx.chatGptPlanSourceState.upsert({
				where: { sourceKind_sourceId: { sourceKind, sourceId } },
				create: { sourceKind, sourceId, ...data },
				update: data,
			}),
	);
}

/**
 * The source answered again: it is no longer spent, and the refusal count
 * starts over. A reset OpenAI reported stays, as the boundary the next
 * window chains from (Fizzy #2770 G9); one Fabric only estimated goes.
 * Skipped when the source's sign-in changed since the answering call read
 * its token (Fizzy #3037).
 */
export function markChatGptPlanSourceAnswered(
	key: ChatGptPlanSourceKey,
	credentialFingerprint: string,
): Promise<boolean> {
	const where = { sourceKind: key.sourceKind, sourceId: key.sourceId };
	return withChatGptPlanCredentialFence(
		where,
		credentialFingerprint,
		async (tx) => {
			await tx.chatGptPlanSourceState.updateMany({
				where: { ...where, consecutiveUnknownResets: { gt: 0 } },
				data: {
					openUntil: null,
					resetAt: null,
					consecutiveUnknownResets: 0,
				},
			});
			await tx.chatGptPlanSourceState.updateMany({
				where,
				data: { openUntil: null },
			});
		},
	);
}

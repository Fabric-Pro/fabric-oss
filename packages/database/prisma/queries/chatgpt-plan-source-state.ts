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
}

export async function recordChatGptPlanSourceExhausted(
	input: ChatGptPlanSourceExhaustion,
): Promise<void> {
	const { sourceKind, sourceId, exhaustedAt, ...fields } = input;
	const data = { ...fields, lastExhaustedAt: exhaustedAt };
	await db.chatGptPlanSourceState.upsert({
		where: { sourceKind_sourceId: { sourceKind, sourceId } },
		create: { sourceKind, sourceId, ...data },
		update: data,
	});
}

/** Forgets a source's spent window: it answered again, or it is gone. */
export async function clearChatGptPlanSourceState(
	key: ChatGptPlanSourceKey,
): Promise<void> {
	await db.chatGptPlanSourceState.deleteMany({
		where: { sourceKind: key.sourceKind, sourceId: key.sourceId },
	});
}

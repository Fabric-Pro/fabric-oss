import { db } from "@repo/database";
import { parlumeLog } from "./parlume-log";
import type { ParlumeSuggestionKind } from "./parlume-suggestions";

const STORED_KIND = {
	answer: "ANSWER",
	missed_question: "MISSED_QUESTION",
} as const satisfies Record<ParlumeSuggestionKind, string>;

export interface ParlumeSuggestionRecord {
	sessionId: string;
	botId: string;
	kind: ParlumeSuggestionKind;
	text: string;
	speaker: string;
	quote: string;
	topic: string;
	/** The chat post's tag, when it was posted in the meeting chat. */
	chatTag: string | null;
}

/**
 * Records a suggestion the bridge accepted, so the Parlume page can list it
 * to the project's readers whoever it was for. Only the live session whose
 * bot the bridge verified may record one; the project, organization, owner
 * and audience come from that session, never from the caller.
 */
export async function recordParlumeSuggestion(
	input: ParlumeSuggestionRecord,
): Promise<boolean> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: input.sessionId,
			providerBotId: input.botId,
			status: "ACTIVE",
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			suggestionAudience: true,
		},
	});
	if (!session) {
		parlumeLog("warn", "suggestion.record_refused", {
			sessionId: input.sessionId,
			botId: input.botId,
		});
		return false;
	}
	await db.parlumeSuggestion.create({
		data: {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			kind: STORED_KIND[input.kind],
			audience: session.suggestionAudience,
			text: input.text,
			speaker: input.speaker,
			quote: input.quote,
			topic: input.topic,
			chatTag: input.chatTag,
		},
		select: { id: true },
	});
	parlumeLog("info", "suggestion.recorded", {
		sessionId: session.id,
		kind: input.kind,
		audience: session.suggestionAudience,
		posted: input.chatTag !== null,
	});
	return true;
}

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { db, getBoundPromptForAgent, hasProjectAccess } from "@repo/database";
import { formatContextsForPrompt, retrieveProjectContexts } from "@repo/rag";
import {
	formatLiveTranscript,
	formatMeetingChat,
	LIVE_TRANSCRIPT_WINDOW_MS,
	MAX_LIVE_TRANSCRIPT_SEGMENTS,
	MAX_PARLUME_CHAT_MESSAGES,
	PARLUME_PROJECT_RAG_CHUNKS,
} from "@repo/temporal/parlume-voice-context";
import {
	PARLUME_SUGGESTION_FALLBACK_BODY,
	PARLUME_SUGGESTION_PROMPT_AGENT_KEY,
} from "@repo/utils/parlume-suggestion-prompt";
import { fenceUntrusted } from "@repo/utils/untrusted-fence";
import { zodSchema } from "ai";
import { z } from "zod";
import { parlumeLog } from "./parlume-log";
import { PARLUME_FEATURE_KEY } from "./parlume-usage";

const MEETING_INPUT_TAG = "meeting_input";
const MAX_SUGGESTION_CHARS = 500;
const MAX_PREVIOUS_SUGGESTIONS = 12;
const MAX_OUTPUT_TOKENS = 300;
/** The tail of the transcript that keys the project search. */
const RAG_QUERY_CHARS = 1_000;

// Lenient on purpose: a model that leaves a field out or adds one is read as
// "no suggestion" in code rather than failing the pass.
const suggestionSchema = z.object({
	suggest: z.boolean().optional(),
	text: z.string().optional(),
});

export type ParlumeSuggestion =
	| { suggest: false }
	| { suggest: true; text: string };

export function normalizeParlumeSuggestion(output: {
	suggest?: boolean;
	text?: string;
}): ParlumeSuggestion {
	const text = output.text?.replace(/\s+/g, " ").trim() ?? "";
	return output.suggest === true && text
		? { suggest: true, text: text.slice(0, MAX_SUGGESTION_CHARS) }
		: { suggest: false };
}

/**
 * One passive suggestion pass for a live meeting: reads the last few minutes
 * of speech, the recent chat and the project's closest passages, and asks a
 * fast model whether one short contribution is worth offering. The bridge
 * decides how often a pass runs and posts what comes back. Never throws: a
 * failed pass is no suggestion.
 */
export async function suggestParlumeMeetingContribution(input: {
	sessionId: string;
	botId: string;
	previous: string[];
}): Promise<ParlumeSuggestion> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: input.sessionId,
			providerBotId: input.botId,
			status: "ACTIVE",
			captureStoppedAt: null,
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			suggestionsEnabled: true,
		},
	});
	if (
		!session?.suggestionsEnabled ||
		!(await hasProjectAccess(
			session.projectId,
			session.userId,
			session.organizationId,
		))
	) {
		return { suggest: false };
	}
	const [speech, chat] = await Promise.all([
		db.parlumeMeetingSegment.findMany({
			where: {
				sessionId: session.id,
				source: "SPEECH",
				createdAt: {
					gte: new Date(Date.now() - LIVE_TRANSCRIPT_WINDOW_MS),
				},
			},
			select: { text: true, speakerName: true },
			orderBy: { createdAt: "desc" },
			take: MAX_LIVE_TRANSCRIPT_SEGMENTS,
		}),
		db.parlumeMeetingSegment.findMany({
			where: { sessionId: session.id, source: "CHAT" },
			select: { text: true, speakerName: true },
			orderBy: { createdAt: "desc" },
			take: MAX_PARLUME_CHAT_MESSAGES,
		}),
	]);
	const transcript = formatLiveTranscript(speech);
	if (!transcript) {
		return { suggest: false };
	}
	try {
		const passages = await retrieveProjectContexts({
			projectId: session.projectId,
			query: transcript.slice(-RAG_QUERY_CHARS),
			userId: session.userId,
			organizationId: session.organizationId,
			topK: PARLUME_PROJECT_RAG_CHUNKS,
		}).catch(() => []);
		const boundPrompt = await getBoundPromptForAgent({
			agentName: PARLUME_SUGGESTION_PROMPT_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
		});
		const { model, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE", complexity: "simple" },
			{
				userId: session.userId,
				organizationId: session.organizationId,
				projectId: session.projectId,
				featureKey: PARLUME_FEATURE_KEY,
				conversationId: session.id,
				jobType: "parlume-live-turn",
				promptVersionId: boundPrompt?.version?.id,
			},
		);
		const meetingChat = formatMeetingChat(chat);
		const previous = input.previous.slice(-MAX_PREVIOUS_SUGGESTIONS);
		const { object } = await generateObject({
			model,
			schema: zodSchema(suggestionSchema),
			instructions:
				boundPrompt?.version?.content?.trim() ||
				PARLUME_SUGGESTION_FALLBACK_BODY,
			prompt: [
				fenceUntrusted(
					MEETING_INPUT_TAG,
					{ source: "transcript" },
					transcript,
				),
				meetingChat
					? fenceUntrusted(
							MEETING_INPUT_TAG,
							{ source: "chat" },
							meetingChat,
						)
					: null,
				passages.length > 0
					? fenceUntrusted(
							MEETING_INPUT_TAG,
							{ source: "project" },
							formatContextsForPrompt(passages),
						)
					: null,
				previous.length > 0
					? fenceUntrusted(
							MEETING_INPUT_TAG,
							{ source: "earlier_suggestions" },
							previous.join("\n"),
						)
					: null,
			]
				.filter(Boolean)
				.join("\n\n"),
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		});
		trackUsage();
		return normalizeParlumeSuggestion(object);
	} catch (error) {
		parlumeLog("warn", "suggestion.failed", {
			sessionId: session.id,
			error:
				error instanceof Error
					? error.message.slice(0, 300)
					: "Unknown error",
		});
		return { suggest: false };
	}
}

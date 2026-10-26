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
const MAX_QUOTE_CHARS = 120;
const MAX_TOPIC_CHARS = 60;
const MAX_PREVIOUS_SUGGESTIONS = 12;
// The fast model may reason before it answers, and its reasoning counts against
// this budget: at 300 a staging pass spent all of it and returned nothing.
const MAX_OUTPUT_TOKENS = 1_500;
/** The tail of the transcript that keys the project search. */
const RAG_QUERY_CHARS = 1_000;
/** Open work items shown to the model, highest priority first. */
const MAX_WORK_ITEMS = 40;
const MAX_WORK_ITEM_TITLE_CHARS = 120;
// Earlier meetings' transcripts are what people said, not the project's
// state: on staging the passages for a meeting were all transcripts of earlier
// meetings with the same remarks, and the model had no fact to offer.
const EXCLUDED_PASSAGE_TYPE = "MEETING_TRANSCRIPT";
/** Distinct documents fetched so enough survive dropping the transcripts. */
const PASSAGE_CANDIDATES = 12;

// Lenient on purpose: a model that leaves a field out or adds one is read as
// "no suggestion" in code rather than failing the pass.
const suggestionSchema = z.object({
	suggest: z.boolean().optional(),
	text: z.string().optional(),
	speaker: z.string().optional(),
	quote: z.string().optional(),
	topic: z.string().optional(),
});

/**
 * A suggestion names what it answers: who said it, a few of their words, and
 * the topic, so the room can tell which remark it is about.
 */
export type ParlumeSuggestion =
	| { suggest: false }
	| {
			suggest: true;
			text: string;
			speaker: string;
			quote: string;
			topic: string;
	  };

function clean(text: string | undefined): string {
	return text?.replace(/\s+/g, " ").trim() ?? "";
}

function comparable(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The model's answer, kept only when it is anchored in the meeting: the
 * quoted words must be something its speaker said in the transcript it was
 * shown. An unanchored or invented reference is no suggestion.
 */
export function normalizeParlumeSuggestion(
	output: z.infer<typeof suggestionSchema>,
	speech: ReadonlyArray<{ text: string; speakerName: string | null }>,
): ParlumeSuggestion {
	const text = clean(output.text);
	const speaker = clean(output.speaker);
	const quote = clean(output.quote)
		.replace(/^["'“”]+|["'“”]+$/g, "")
		.slice(0, MAX_QUOTE_CHARS);
	const topic = clean(output.topic).slice(0, MAX_TOPIC_CHARS);
	const said = comparable(quote);
	const anchored =
		said.length > 0 &&
		speech.some(
			(segment) =>
				comparable(segment.speakerName ?? "Attendee") ===
					comparable(speaker) &&
				comparable(segment.text).includes(said),
		);
	return output.suggest === true && text && topic && anchored
		? {
				suggest: true,
				text: text.slice(0, MAX_SUGGESTION_CHARS),
				speaker,
				quote,
				topic,
			}
		: { suggest: false };
}

/**
 * The project's open work items as the model sees them, one per line:
 * identifier, title, status, priority and owner.
 */
export function formatParlumeWorkItems(
	items: ReadonlyArray<{
		identifier: string;
		title: string;
		priority: string;
		status: string;
		owner: string | null;
	}>,
	total: number,
): string {
	if (items.length === 0) {
		return "No open work items.";
	}
	const lines = items.map(
		(item) =>
			`${item.identifier} | ${clean(item.title).slice(0, MAX_WORK_ITEM_TITLE_CHARS)} | ${item.status} | ${item.priority.replace("_", " ").toLowerCase()} | owner: ${item.owner ?? "unassigned"}`,
	);
	return total > items.length
		? [
				...lines,
				`(${total - items.length} more open work items not shown)`,
			].join("\n")
		: lines.join("\n");
}

async function loadOpenWorkItems(projectId: string): Promise<string> {
	const where = { projectId, status: { isFinal: false } };
	const [stories, total] = await Promise.all([
		db.userStory.findMany({
			where,
			select: {
				identifier: true,
				title: true,
				priority: true,
				assigneeId: true,
				status: { select: { name: true } },
			},
			orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
			take: MAX_WORK_ITEMS,
		}),
		db.userStory.count({ where }),
	]);
	const assigneeIds = [
		...new Set(stories.flatMap((story) => story.assigneeId ?? [])),
	];
	const owners = new Map(
		(assigneeIds.length > 0
			? await db.user.findMany({
					where: { id: { in: assigneeIds } },
					select: { id: true, name: true },
				})
			: []
		).map((user) => [user.id, user.name]),
	);
	return formatParlumeWorkItems(
		stories.map((story) => ({
			identifier: story.identifier,
			title: story.title,
			priority: story.priority,
			status: story.status.name,
			owner: story.assigneeId
				? (owners.get(story.assigneeId) ?? null)
				: null,
		})),
		total,
	);
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
		const [workItems, retrieved] = await Promise.all([
			loadOpenWorkItems(session.projectId),
			retrieveProjectContexts({
				projectId: session.projectId,
				query: transcript.slice(-RAG_QUERY_CHARS),
				userId: session.userId,
				organizationId: session.organizationId,
				diversify: true,
				skipRerank: true,
				maxContexts: PASSAGE_CANDIDATES,
			}).catch(() => []),
		]);
		const passages = retrieved
			.filter((passage) => passage.type !== EXCLUDED_PASSAGE_TYPE)
			.slice(0, PARLUME_PROJECT_RAG_CHUNKS);
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
				fenceUntrusted(
					MEETING_INPUT_TAG,
					{ source: "work_items" },
					workItems,
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
		const suggestion = normalizeParlumeSuggestion(object, speech);
		if (!suggestion.suggest && object.suggest === true) {
			parlumeLog("info", "suggestion.unanchored", {
				sessionId: session.id,
			});
		}
		return suggestion;
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

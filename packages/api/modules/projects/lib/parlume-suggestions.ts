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
	findPriorSeriesTranscripts,
	readTextItems,
} from "@repo/temporal/prior-series-transcripts";
import {
	PARLUME_SUGGESTION_FALLBACK_BODY,
	PARLUME_SUGGESTION_PROMPT_AGENT_KEY,
} from "@repo/utils/parlume-suggestion-prompt";
import { fenceUntrusted } from "@repo/utils/untrusted-fence";
import { zodSchema } from "ai";
import { z } from "zod";
import { utcDayRange } from "../procedures/meeting-digest/occurrence-day";
import { parlumeLog } from "./parlume-log";
import type { ParlumeSuggestionAudience } from "./parlume-suggestion-audience";
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
/**
 * The meeting before the live window, most recent kept: what the model checks
 * a missed question against, so it does not raise one the room already asked.
 * About ten minutes of conversation (roughly 2,500 input tokens) on top of a
 * pass that may run every 45 seconds; older remarks matter less, and the
 * agenda and the previous meeting's questions already cover the meeting's
 * scope.
 */
const MAX_EARLIER_MEETING_CHARS = 10_000;
/** Segments read for the earlier meeting; short remarks need more than the char budget suggests. */
const MAX_EARLIER_MEETING_SEGMENTS = 400;
const MAX_AGENDA_CHARS = 4_000;
const MAX_PREVIOUS_QUESTIONS = 10;
/** The previous meeting of a series is looked for this far back, as the recap does. */
const PREVIOUS_MEETING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Lenient on purpose: a model that leaves a field out or adds one is read as
// "no suggestion" in code rather than failing the pass. A missing or unknown
// kind is an answer, so an organization's edited prompt that never mentions
// kind keeps working.
const suggestionSchema = z.object({
	suggest: z.boolean().optional(),
	kind: z.string().optional(),
	text: z.string().optional(),
	speaker: z.string().optional(),
	quote: z.string().optional(),
	topic: z.string().optional(),
});

/** An answer to a remark, or a question the meeting may have missed. */
export type ParlumeSuggestionKind = "answer" | "missed_question";

/**
 * A suggestion names what it answers: who said it, a few of their words, and
 * the topic, so the room can tell which remark it is about. A missed question
 * names the remark that opened the topic it belongs to.
 */
export type ParlumeSuggestion =
	| { suggest: false }
	| {
			suggest: true;
			kind: ParlumeSuggestionKind;
			text: string;
			speaker: string;
			quote: string;
			topic: string;
	  };

/** A pass's answer: the suggestion, and where the session sends it. */
export type ParlumeSuggestionPass =
	| { suggest: false }
	| (ParlumeSuggestion & { audience: ParlumeSuggestionAudience });

type SpokenLine = { text: string; speakerName: string | null };

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
 * shown. An unanchored or invented reference is no suggestion. An answer
 * answers a remark of the last few minutes; a missed question may point at
 * the remark that opened its topic earlier in the meeting.
 */
export function normalizeParlumeSuggestion(
	output: z.infer<typeof suggestionSchema>,
	speech: ReadonlyArray<SpokenLine>,
	earlierSpeech: ReadonlyArray<SpokenLine> = [],
): ParlumeSuggestion {
	const kind: ParlumeSuggestionKind =
		comparable(output.kind ?? "").replace(/\s+/g, "_") === "missed_question"
			? "missed_question"
			: "answer";
	const shown =
		kind === "missed_question" ? [...speech, ...earlierSpeech] : speech;
	const text = clean(output.text);
	const speaker = clean(output.speaker);
	const quote = clean(output.quote)
		.replace(/^["'“”]+|["'“”]+$/g, "")
		.slice(0, MAX_QUOTE_CHARS);
	const topic = clean(output.topic).slice(0, MAX_TOPIC_CHARS);
	const said = comparable(quote);
	const anchored =
		said.length > 0 &&
		shown.some(
			(segment) =>
				comparable(segment.speakerName ?? "Attendee") ===
					comparable(speaker) &&
				comparable(segment.text).includes(said),
		);
	return output.suggest === true && text && topic && anchored
		? {
				suggest: true,
				kind,
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
 * The meeting before the live window as lines, oldest first, cut from the
 * front so the most recent remarks are kept.
 */
function formatEarlierMeeting(newestFirst: ReadonlyArray<SpokenLine>): string {
	return [...newestFirst]
		.reverse()
		.map(({ text, speakerName }) => `${speakerName ?? "Attendee"}: ${text}`)
		.join("\n")
		.slice(-MAX_EARLIER_MEETING_CHARS);
}

type SeriesScope = {
	projectId: string;
	organizationId: string;
	userId: string;
	linkedMeetingId: string;
	/** The occurrence this session is in: its start, or when it was invited by hand. */
	occurrence: Date;
};

/**
 * The occurrence's ready agenda, resolved on its UTC day as the Meeting
 * Digest's agenda sheet resolves it.
 */
async function loadAgenda(scope: SeriesScope): Promise<string | null> {
	const agenda = await db.projectMeetingAgenda.findFirst({
		where: {
			projectId: scope.projectId,
			linkedMeetingId: scope.linkedMeetingId,
			status: "READY",
			occurrenceStart: utcDayRange(scope.occurrence),
		},
		orderBy: { createdAt: "desc" },
		select: { content: true },
	});
	return agenda?.content?.trim().slice(0, MAX_AGENDA_CHARS) || null;
}

/** The open questions of the series' latest synced transcript before this occurrence. */
async function loadPreviousQuestions(
	scope: SeriesScope,
): Promise<string | null> {
	const [previous] = await findPriorSeriesTranscripts({
		projectId: scope.projectId,
		organizationId: scope.organizationId,
		userId: scope.userId,
		linkedMeetingId: scope.linkedMeetingId,
		since: new Date(
			scope.occurrence.getTime() - PREVIOUS_MEETING_WINDOW_MS,
		),
		before: scope.occurrence,
		take: 1,
		actionItemCap: 0,
	});
	const questions = readTextItems(previous?.extractedQuestions).slice(
		0,
		MAX_PREVIOUS_QUESTIONS,
	);
	return questions.length > 0
		? questions.map((question) => `- ${question}`).join("\n")
		: null;
}

/**
 * One passive suggestion pass for a live meeting: reads the last few minutes
 * of speech, the meeting before them, the occurrence's agenda and the series'
 * previous open questions, the recent chat and the project's closest
 * passages, and asks a fast model whether one short contribution (an answer,
 * or a question the meeting may have missed) is worth offering. The bridge
 * decides how often a pass runs and where what comes back goes: the answer
 * carries the session's current audience. Never throws: a failed pass is no
 * suggestion.
 *
 * `teamAudience` is the bridge saying it can keep a suggestion off the chat.
 * A bridge that does not would post a team-only suggestion to the meeting,
 * so a TEAM session gets no suggestion from it.
 */
export async function suggestParlumeMeetingContribution(input: {
	sessionId: string;
	botId: string;
	previous: string[];
	teamAudience?: boolean;
}): Promise<ParlumeSuggestionPass> {
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
			suggestionAudience: true,
			linkedMeetingId: true,
			occurrenceStart: true,
			createdAt: true,
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
	if (session.suggestionAudience === "TEAM" && !input.teamAudience) {
		parlumeLog("warn", "suggestion.audience_unsupported", {
			sessionId: session.id,
		});
		return { suggest: false };
	}
	const audience: ParlumeSuggestionAudience = session.suggestionAudience;
	const windowStart = new Date(Date.now() - LIVE_TRANSCRIPT_WINDOW_MS);
	const [speech, earlierSpeech, chat] = await Promise.all([
		db.parlumeMeetingSegment.findMany({
			where: {
				sessionId: session.id,
				source: "SPEECH",
				createdAt: { gte: windowStart },
			},
			select: { text: true, speakerName: true },
			orderBy: { createdAt: "desc" },
			take: MAX_LIVE_TRANSCRIPT_SEGMENTS,
		}),
		db.parlumeMeetingSegment.findMany({
			where: {
				sessionId: session.id,
				source: "SPEECH",
				createdAt: { lt: windowStart },
			},
			select: { text: true, speakerName: true },
			orderBy: { createdAt: "desc" },
			take: MAX_EARLIER_MEETING_SEGMENTS,
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
	const transcriptTail = transcript.slice(-RAG_QUERY_CHARS);
	const chatBudget = RAG_QUERY_CHARS - transcriptTail.length - 1;
	const chatTail =
		chatBudget > 0 ? formatMeetingChat(chat).slice(-chatBudget) : "";
	const query = [transcriptTail, chatTail].filter(Boolean).join(" ");
	const earlierMeeting = formatEarlierMeeting(earlierSpeech);
	const series: SeriesScope | null = session.linkedMeetingId
		? {
				projectId: session.projectId,
				organizationId: session.organizationId,
				userId: session.userId,
				linkedMeetingId: session.linkedMeetingId,
				occurrence: session.occurrenceStart ?? session.createdAt,
			}
		: null;
	try {
		const [workItems, retrieved, agenda, previousQuestions] =
			await Promise.all([
				loadOpenWorkItems(session.projectId),
				retrieveProjectContexts({
					projectId: session.projectId,
					query,
					userId: session.userId,
					organizationId: session.organizationId,
					diversify: true,
					skipRerank: true,
					maxContexts: PASSAGE_CANDIDATES,
				}).catch(() => []),
				// Context for missed questions only: a pass goes on without it.
				series ? loadAgenda(series).catch(() => null) : null,
				series ? loadPreviousQuestions(series).catch(() => null) : null,
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
				earlierMeeting
					? fenceUntrusted(
							MEETING_INPUT_TAG,
							{ source: "earlier_meeting" },
							earlierMeeting,
						)
					: null,
				agenda
					? fenceUntrusted(
							MEETING_INPUT_TAG,
							{ source: "agenda" },
							agenda,
						)
					: null,
				previousQuestions
					? fenceUntrusted(
							MEETING_INPUT_TAG,
							{ source: "previous_meeting_questions" },
							previousQuestions,
						)
					: null,
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
		const suggestion = normalizeParlumeSuggestion(
			object,
			speech,
			earlierSpeech,
		);
		if (!suggestion.suggest && object.suggest === true) {
			parlumeLog("info", "suggestion.unanchored", {
				sessionId: session.id,
			});
		}
		return { ...suggestion, audience };
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

import { generateText, getAIModelWithMetadata } from "@repo/ai";
import {
	db,
	getBoundPromptForAgent,
	type Prisma,
	type StoryChangeItem,
} from "@repo/database";
import {
	PARLUME_RECAP_FALLBACK_BODY,
	PARLUME_RECAP_PROMPT_AGENT_KEY,
} from "@repo/utils/parlume-recap-prompt";
import { fenceUntrusted } from "@repo/utils/untrusted-fence";
import { collectStoryActivity } from "./daily-brief/collect-story-activity";
import {
	findPriorSeriesTranscripts,
	readTextItems,
} from "./meeting-agenda/prior-series-transcripts";
import { parlumeActivityLog } from "./parlume-log";
import { postParlumeMeetingChat } from "./parlume-voice";

const RECAP_INPUT_TAG = "recap_input";
/** A series quiet for longer than this has nothing current to recap. */
const PREVIOUS_MEETING_WINDOW_DAYS = 90;
/** Earlier sessions read to find the latest one whose notes were written. */
const PREVIOUS_SESSION_CANDIDATES = 5;
const MAX_NOTES_CHARS = 8_000;
const MAX_LIST_ITEMS = 10;
const MAX_WORK_ITEMS = 15;
const MAX_WORK_ITEM_TITLE_CHARS = 120;
// The fast model may reason before it answers, and its reasoning counts
// against this budget (see the suggestion pass).
const MAX_OUTPUT_TOKENS = 1_500;
const MAX_RECAP_CHARS = 1_500;

type PreviousMeeting = {
	source: "parlume_notes" | "transcript";
	/** When the previous meeting happened; what changed after it is "since". */
	heldAt: Date;
	material: string;
};

/**
 * Posts the "Since last time" recap, once, when Parlume has just been admitted
 * to a meeting of a linked series: what the previous meeting of the series
 * decided and left open, and the project's work items changed since. The
 * previous meeting is the latest earlier Parlume session of the series whose
 * notes were written, or else the series' latest synced transcript. Every read
 * is scoped to the session's own project and organization. With Chat
 * suggestions off for the session, no previous meeting, or a model that finds
 * nothing worth saying, nothing is posted.
 *
 * Best effort: a failure is logged and the activity never throws, so a recap
 * cannot affect the meeting.
 */
export async function postParlumeSeriesRecap(input: {
	sessionId: string;
}): Promise<void> {
	const { sessionId } = input;
	const skip = (reason: string) =>
		parlumeActivityLog("info", "recap.skipped", { sessionId, reason });
	try {
		const session = await db.parlumeMeetingSession.findUnique({
			where: { id: sessionId },
			select: {
				id: true,
				status: true,
				projectId: true,
				organizationId: true,
				userId: true,
				linkedMeetingId: true,
				suggestionsEnabled: true,
			},
		});
		// Chat suggestions is the consent for Parlume's unprompted chat posts.
		if (session && !session.suggestionsEnabled) {
			skip("suggestions_off");
			return;
		}
		if (!session?.linkedMeetingId) {
			skip("not_series");
			return;
		}
		if (session.status !== "ACTIVE") {
			skip("not_live");
			return;
		}
		const now = new Date();
		const scope = {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			linkedMeetingId: session.linkedMeetingId,
			since: new Date(
				now.getTime() -
					PREVIOUS_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
			),
			now,
		};
		const previous =
			(await previousParlumeNotes(scope)) ??
			(await previousTranscript(scope));
		if (!previous) {
			skip("no_previous_meeting");
			return;
		}
		const { stories } = await collectStoryActivity({
			projectId: session.projectId,
			organizationId: session.organizationId,
			timeWindowStart: previous.heldAt,
			timeWindowEnd: now,
		});
		const workItems = formatWorkItems(stories);
		const boundPrompt = await getBoundPromptForAgent({
			agentName: PARLUME_RECAP_PROMPT_AGENT_KEY,
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
				featureKey: "parlume",
				conversationId: session.id,
				jobType: "parlume-live-turn",
				promptVersionId: boundPrompt?.version?.id,
			},
		);
		const result = await generateText({
			model,
			instructions:
				boundPrompt?.version?.content?.trim() ||
				PARLUME_RECAP_FALLBACK_BODY,
			prompt: [
				fenceUntrusted(
					RECAP_INPUT_TAG,
					{ source: "previous_meeting" },
					previous.material,
				),
				fenceUntrusted(
					RECAP_INPUT_TAG,
					{ source: "work_items" },
					workItems.text,
				),
			].join("\n\n"),
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		});
		trackUsage();
		const recap = result.text.trim();
		if (!recap) {
			skip("nothing_to_recap");
			return;
		}
		const sent = await postParlumeMeetingChat({
			sessionId: session.id,
			message: recap.slice(0, MAX_RECAP_CHARS),
		});
		parlumeActivityLog(sent.sent ? "info" : "warn", "recap.posted", {
			sessionId,
			source: previous.source,
			workItems: workItems.count,
			chars: recap.length,
			sent: sent.sent,
			...(sent.sent ? { tag: sent.tag } : { reason: sent.reason }),
		});
	} catch (error) {
		parlumeActivityLog("warn", "recap.failed", {
			sessionId,
			error:
				error instanceof Error
					? `${error.name}: ${error.message}`.slice(0, 300)
					: "Unknown error",
		});
	}
}

type RecapScope = {
	sessionId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	linkedMeetingId: string;
	since: Date;
	now: Date;
};

/**
 * The latest earlier Parlume session of the series whose notes were written.
 * Ordered by when the bot was admitted rather than by occurrence start: a
 * session invited by hand has no occurrence start, and an automatic join is
 * admitted within minutes of its occurrence's start.
 */
async function previousParlumeNotes(
	scope: RecapScope,
): Promise<PreviousMeeting | null> {
	const candidates = await db.parlumeMeetingSession.findMany({
		where: {
			linkedMeetingId: scope.linkedMeetingId,
			projectId: scope.projectId,
			organizationId: scope.organizationId,
			id: { not: scope.sessionId },
			status: "ENDED",
			transcriptContextId: { not: null },
			joinedAt: { gte: scope.since, lt: scope.now },
		},
		orderBy: { joinedAt: "desc" },
		take: PREVIOUS_SESSION_CANDIDATES,
		select: {
			transcriptContextId: true,
			occurrenceStart: true,
			joinedAt: true,
			endedAt: true,
		},
	});
	const contextIds = candidates.flatMap((candidate) =>
		candidate.transcriptContextId ? [candidate.transcriptContextId] : [],
	);
	if (contextIds.length === 0) {
		return null;
	}
	const contexts = await db.projectContext.findMany({
		where: {
			id: { in: contextIds },
			projectId: scope.projectId,
			organizationId: scope.organizationId,
		},
		select: { id: true, metadata: true },
	});
	const notesByContext = new Map(
		contexts.map((context) => [
			context.id,
			completedNotes(context.metadata),
		]),
	);
	for (const candidate of candidates) {
		const notes = candidate.transcriptContextId
			? notesByContext.get(candidate.transcriptContextId)
			: null;
		const heldAt = candidate.endedAt ?? candidate.joinedAt;
		if (notes && heldAt) {
			return {
				source: "parlume_notes",
				heldAt,
				material: [
					`Previous meeting on ${isoDate(candidate.occurrenceStart ?? heldAt)}`,
					"Notes:",
					notes.slice(0, MAX_NOTES_CHARS),
				].join("\n"),
			};
		}
	}
	return null;
}

function completedNotes(metadata: Prisma.JsonValue): string | null {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}
	const notes = metadata.parlumeNotes;
	return metadata.parlumeNotesStatus === "COMPLETED" &&
		typeof notes === "string" &&
		notes.trim()
		? notes.trim()
		: null;
}

/** The series' latest synced transcript, with its insights and open action items. */
async function previousTranscript(
	scope: RecapScope,
): Promise<PreviousMeeting | null> {
	const [transcript] = await findPriorSeriesTranscripts({
		projectId: scope.projectId,
		organizationId: scope.organizationId,
		userId: scope.userId,
		linkedMeetingId: scope.linkedMeetingId,
		since: scope.since,
		before: scope.now,
		take: 1,
		actionItemCap: MAX_LIST_ITEMS,
	});
	if (!transcript?.meetingDate) {
		return null;
	}
	const list = (title: string, items: string[]) =>
		items.length > 0
			? [
					`${title}:`,
					...items
						.slice(0, MAX_LIST_ITEMS)
						.map((item) => `- ${item}`),
				]
			: [];
	const actionItems = transcript.actionItems.map((item) =>
		[
			item.text,
			item.tentativeOwnerName
				? `owner: ${item.tentativeOwnerName}`
				: null,
			item.dueHint ? `due: ${item.dueHint}` : null,
		]
			.filter(Boolean)
			.join(" · "),
	);
	const sections = [
		transcript.summary ? `Summary: ${transcript.summary}` : null,
		...list("Decisions", readTextItems(transcript.extractedDecisions)),
		...list("Open questions", readTextItems(transcript.extractedQuestions)),
		...list("Open action items", actionItems),
	].filter((line): line is string => Boolean(line));
	if (sections.length === 0) {
		return null;
	}
	return {
		source: "transcript",
		heldAt: transcript.meetingDate,
		material: [
			`Previous meeting${transcript.meetingSubject ? ` "${transcript.meetingSubject}"` : ""} on ${isoDate(transcript.meetingDate)}`,
			...sections,
		]
			.join("\n")
			.slice(0, MAX_NOTES_CHARS),
	};
}

/**
 * One line per work item changed since the previous meeting, newest first.
 * The collector lists an item once for its own edit and again for each saved
 * version; the first, which carries its current status, is kept.
 */
function formatWorkItems(stories: StoryChangeItem[]): {
	text: string;
	count: number;
} {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const story of stories) {
		if (lines.length >= MAX_WORK_ITEMS) {
			break;
		}
		if (seen.has(story.storyCuid)) {
			continue;
		}
		seen.add(story.storyCuid);
		lines.push(
			[
				story.storyIdentifier,
				story.title.slice(0, MAX_WORK_ITEM_TITLE_CHARS),
				story.kind === "created" ? "created" : "edited",
				story.toValue,
			]
				.filter(Boolean)
				.join(" · "),
		);
	}
	return {
		text:
			lines.length > 0
				? lines.join("\n")
				: "No work items were created or edited since the previous meeting.",
		count: lines.length,
	};
}

function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

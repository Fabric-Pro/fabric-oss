import { db } from "@repo/database";
import { PARLUME_BOT_NAME } from "@repo/utils/parlume-notes";
import { findParlumeMeetingSessions } from "./parlume-meeting-sessions";

const PARLUME_TAG = /^\[P(\d{1,6})\]/;
const MAX_EARLIER_SESSIONS = 20;
const MAX_TAGGED_MESSAGES = 200;
/** The bridge refuses a first tag above this. */
const MAX_FIRST_TAG = 100_000;

/**
 * Keeps the highest tag Fabric relayed for a session, before the post is sent:
 * a tag that goes unused leaves a gap, and a tag counted too late is reused.
 */
export async function recordParlumeChatTag(
	sessionId: string,
	message: string,
): Promise<void> {
	const digits = PARLUME_TAG.exec(message)?.[1];
	if (digits === undefined) {
		return;
	}
	const tag = Number(digits);
	await db.parlumeMeetingSession.updateMany({
		where: {
			id: sessionId,
			OR: [{ lastChatTag: null }, { lastChatTag: { lt: tag } }],
		},
		data: { lastChatTag: tag },
	});
}

/**
 * Gives the session's recap on the Parlume page the tag of its chat post. The
 * recap is recorded before it is posted; one the bridge held until the chat
 * opened is posted later, and only this records its tag.
 */
export async function recordParlumeRecapTag(
	sessionId: string,
	message: string,
): Promise<void> {
	const digits = PARLUME_TAG.exec(message)?.[1];
	if (digits === undefined) {
		return;
	}
	await db.parlumeSuggestion.updateMany({
		where: { sessionId, kind: "RECAP", chatTag: null },
		data: { chatTag: `P${Number(digits)}` },
	});
}

/**
 * Where a new session's chat tags start, in a meeting Parlume was in before.
 * Each session's bridge numbers its own posts, from P1 by default; re-invited
 * to the same meeting, Parlume would post a second [P1], and "go P1" would
 * play the new post in place of the one the participant meant. Counted from
 * the highest tag Fabric relayed for each earlier session, the tagged posts
 * their meeting chat showed back from Parlume, and the channel posts they
 * made, within the organization. The relayed tag covers the notice a session
 * posts just before it leaves, which shows back only after it has ended.
 */
export async function parlumeChatTagStart(meeting: {
	organizationId: string;
	meetingUrl: string;
}): Promise<number> {
	const sessions = await findParlumeMeetingSessions(meeting, {
		take: MAX_EARLIER_SESSIONS,
	});
	if (sessions.length === 0) {
		return 1;
	}
	const sessionId = { in: sessions.map((session) => session.id) };
	const [messages, channelPosts] = await Promise.all([
		db.parlumeMeetingSegment.findMany({
			where: {
				sessionId,
				source: "CHAT",
				text: { startsWith: "[P" },
				speakerName: {
					startsWith: PARLUME_BOT_NAME,
					mode: "insensitive",
				},
			},
			orderBy: { createdAt: "desc" },
			take: MAX_TAGGED_MESSAGES,
			select: { text: true },
		}),
		db.parlumeChannelPost.findMany({
			where: { sessionId },
			orderBy: { createdAt: "desc" },
			take: MAX_TAGGED_MESSAGES,
			select: { tag: true },
		}),
	]);
	const issued = [
		...messages.map((message) => PARLUME_TAG.exec(message.text)?.[1]),
		...channelPosts.map((post) => /^P(\d{1,6})$/.exec(post.tag)?.[1]),
	]
		.filter((digits): digits is string => digits !== undefined)
		.map(Number)
		.concat(sessions.flatMap((session) => session.lastChatTag ?? []));
	return Math.min(Math.max(0, ...issued) + 1, MAX_FIRST_TAG);
}

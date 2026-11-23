import { db, type Prisma } from "@repo/database";
import type { ParlumeMeetingSessionStatus } from "@repo/database/prisma/generated/enums";
import {
	teamsMeetingIdentity,
	teamsMeetingJoinUrl,
} from "@repo/integrations/microsoft/parlume-channel";

// Anything a link may percent-escape: a run between these is spelled the same
// in every form of the link.
const UNESCAPED_RUN_BREAK = /[^A-Za-z0-9_.!~*'()-]+/;

/**
 * The meeting a stored join link names, as one string: every spelling of a
 * Teams join link gives the same key (`teamsMeetingIdentity`), and any other
 * link, such as a short `/meet/<id>` link, is its lower-cased join path. A
 * session stores it, and a partial unique index allows one live session per
 * key in an organization. `joinUrl` is already `teamsMeetingJoinUrl`'s.
 */
export function parlumeMeetingKey(joinUrl: string): string {
	return teamsMeetingIdentity(joinUrl) ?? joinUrl.toLowerCase();
}

/**
 * The organization's sessions in one meeting, newest first. A Teams join link
 * is compared by `teamsMeetingIdentity`, its decoded path: a session may have
 * stored its thread id escaped or not, with a trailing slash or without. The
 * rows are narrowed by the longest part of that path every spelling keeps as
 * it is. Any other link, such as a short `/meet/<id>` link, is compared by
 * `teamsMeetingJoinUrl`, which takes the meeting out of a web link's fragment
 * and drops the passcode. A link that names no meeting has no sessions: every
 * meeting would share it.
 */
export async function findParlumeMeetingSessions(
	meeting: { organizationId: string; meetingUrl: string },
	options: {
		take: number;
		statuses?: readonly ParlumeMeetingSessionStatus[];
	},
	client: Prisma.TransactionClient = db,
) {
	const joinUrl = teamsMeetingJoinUrl(meeting.meetingUrl);
	if (!joinUrl) {
		return [];
	}
	const identity = teamsMeetingIdentity(joinUrl);
	const scope = {
		organizationId: meeting.organizationId,
		...(options.statuses ? { status: { in: [...options.statuses] } } : {}),
	};
	const query = {
		orderBy: { createdAt: "desc" },
		take: options.take,
		select: {
			id: true,
			projectId: true,
			status: true,
			lastChatTag: true,
			meetingUrl: true,
		},
	} as const;
	if (!identity) {
		return client.parlumeMeetingSession.findMany({
			...query,
			where: {
				...scope,
				meetingUrl: { equals: joinUrl, mode: "insensitive" },
			},
		});
	}
	const path = decodeURIComponent(new URL(joinUrl).pathname);
	const unescaped = path
		.split(UNESCAPED_RUN_BREAK)
		.reduce((longest, run) =>
			run.length > longest.length ? run : longest,
		);
	const candidates = await client.parlumeMeetingSession.findMany({
		...query,
		where: { ...scope, meetingUrl: { contains: unescaped } },
	});
	return candidates.filter(
		(session) =>
			session.meetingUrl !== null &&
			teamsMeetingIdentity(session.meetingUrl) === identity,
	);
}

import { db, type Prisma } from "@repo/database";
import { Permissions } from "@repo/permissions";
import {
	type ParlumeConfidentialSwitch,
	parlumeConfidentialNotice,
} from "@repo/utils/parlume-confidential";
import { userHasProjectPermission } from "../../../orpc/middleware/require-permission";
import {
	bridgeControlUrlForSession,
	getParlumeBridgeSettings,
} from "./parlume-attendee";
import { parlumeLog } from "./parlume-log";

/**
 * Who may read a confidential meeting's discussion and what was made from it
 * (notes, requests and their answers, proposed changes, suggestions, the
 * transcript): its verified attendees who still read the project, and the
 * project's managers, the holders of PROJECT_MEMBERS_MANAGE. Someone absent
 * from the meeting reads it only as a manager.
 */
export async function isParlumeConfidentialReader(input: {
	projectId: string;
	userId: string;
	attendeeUserIds: string[];
}): Promise<boolean> {
	const { projectId, userId } = input;
	if (
		await userHasProjectPermission({
			projectId,
			userId,
			permission: Permissions.PROJECT_MEMBERS_MANAGE,
		})
	) {
		return true;
	}
	return (
		input.attendeeUserIds.includes(userId) &&
		(await userHasProjectPermission({
			projectId,
			userId,
			permission: Permissions.PROJECT_READ,
		}))
	);
}

/**
 * Whether this reader may see a session's derived content: always for a
 * session that is not confidential, otherwise as `isParlumeConfidentialReader`.
 */
export function mayReadParlumeSessionContent(input: {
	projectId: string;
	userId: string;
	session: { confidential: boolean; attendeeUserIds: string[] };
}): Promise<boolean> {
	if (!input.session.confidential) {
		return Promise.resolve(true);
	}
	return isParlumeConfidentialReader({
		projectId: input.projectId,
		userId: input.userId,
		attendeeUserIds: input.session.attendeeUserIds,
	});
}

/**
 * The project's confidential sessions this reader may not see the content
 * of, by session and by transcript context. A caller has already checked
 * that the reader may read the project.
 */
export async function withheldConfidentialParlumeSessions(input: {
	projectId: string;
	userId: string;
}): Promise<{ sessionIds: Set<string>; contextIds: Set<string> }> {
	const sessions = await db.parlumeMeetingSession.findMany({
		where: {
			projectId: input.projectId,
			confidential: true,
			NOT: { attendeeUserIds: { has: input.userId } },
		},
		select: { id: true, transcriptContextId: true },
	});
	if (
		sessions.length === 0 ||
		(await userHasProjectPermission({
			projectId: input.projectId,
			userId: input.userId,
			permission: Permissions.PROJECT_MEMBERS_MANAGE,
		}))
	) {
		return { sessionIds: new Set(), contextIds: new Set() };
	}
	return {
		sessionIds: new Set(sessions.map((session) => session.id)),
		contextIds: new Set(
			sessions.flatMap((session) =>
				session.transcriptContextId
					? [session.transcriptContextId]
					: [],
			),
		),
	};
}

/**
 * Who a meeting turn may look things up for, and whether it may use what the
 * meeting said in its confidential part. The asker counts only when Fabric
 * confirmed them in this meeting (`attendeeUserIds`) and the bridge has them
 * present now (`attendees`). The confidential part is used only when
 * everyone present is one of the meeting's verified attendees, its readers,
 * and no guest is or was expected in the meeting: a guest has no Fabric
 * account, so the bridge never lists one among the attendees.
 */
export function parlumeTurnAudience(input: {
	requester: string | null | undefined;
	attendees: string[];
	attendeeUserIds: string[];
	guests: boolean;
}): { requesterUserId: string | null; withConfidential: boolean } {
	const verified = new Set(input.attendeeUserIds);
	const requester = input.requester ?? null;
	return {
		requesterUserId:
			requester &&
			verified.has(requester) &&
			input.attendees.includes(requester)
				? requester
				: null,
		withConfidential:
			!input.guests &&
			input.attendees.length > 0 &&
			input.attendees.every((userId) => verified.has(userId)),
	};
}

/**
 * A transcript context's metadata without the meeting notes Parlume wrote
 * into it, for a reader who may not see a confidential meeting's notes.
 */
export function withoutParlumeNotes(
	metadata: Prisma.JsonValue,
): Prisma.JsonValue {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		Array.isArray(metadata) ||
		!("parlumeNotes" in metadata || "parlumeNotesItems" in metadata)
	) {
		return metadata;
	}
	const {
		parlumeNotes: _notes,
		parlumeNotesItems: _items,
		...rest
	} = metadata;
	return rest;
}

/** Records a participant Fabric confirmed as a verified attendee, once. */
export async function recordParlumeAttendee(input: {
	sessionId: string;
	userId: string;
}): Promise<void> {
	await db.parlumeMeetingSession.updateMany({
		where: {
			id: input.sessionId,
			NOT: { attendeeUserIds: { has: input.userId } },
		},
		data: { attendeeUserIds: { push: input.userId } },
	});
}

/** What the saved transcript shows where the confidential part starts or ends. */
function markerText(change: ParlumeConfidentialSwitch, by: string): string {
	return change === "on"
		? `Confidential from here, marked by ${by}.`
		: `Confidential part ended by ${by}.`;
}

/**
 * The session fields `setParlumeConfidentialRange` reads: whether the part is
 * open, and whether a guest is or was expected in the meeting.
 */
export const confidentialRangeSelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	confidentialSince: true,
	externalInvitees: true,
	guestJoinedAt: true,
} as const;

type ConfidentialRangeSession = {
	id: string;
	projectId: string;
	organizationId: string;
	userId: string;
	confidentialSince: Date | null;
	externalInvitees: boolean;
	guestJoinedAt: Date | null;
};

/**
 * Starts or ends the meeting's confidential part. Starting only keeps more
 * to fewer people, so anyone in the meeting may. Ending widens who reads what
 * is said next, so it is refused while a guest is or was expected in the
 * meeting; a project manager can end it on the Parlume page. Repeating the
 * current state changes nothing. `open` is whether the part runs afterwards.
 */
export async function setParlumeConfidentialRange(input: {
	session: ConfidentialRangeSession;
	switch: ParlumeConfidentialSwitch;
	by: string | null;
	/** Set by the Parlume page; a command in the meeting is never forced. */
	force?: boolean;
	offsetMs?: number | null;
}): Promise<{ changed: boolean; open: boolean }> {
	const { session } = input;
	const by = input.by?.trim() || "a meeting member";
	const on = input.switch === "on";
	if (
		!on &&
		!input.force &&
		(session.externalInvitees || session.guestJoinedAt !== null)
	) {
		return { changed: false, open: session.confidentialSince !== null };
	}
	const now = new Date();
	const changed = await db.$transaction(async (tx) => {
		const updated = await tx.parlumeMeetingSession.updateMany({
			where: on
				? { id: session.id, confidentialSince: null }
				: { id: session.id, confidentialSince: { not: null } },
			data: on
				? {
						confidential: true,
						confidentialSince: now,
						confidentialBy: by,
					}
				: { confidentialSince: null, confidentialBy: by },
		});
		if (updated.count === 0) {
			return false;
		}
		// The transcript is read in meeting-time order. A mark with no time
		// of its own (the Parlume page, or a chat message) takes the time of
		// the last thing captured, so it sits where it was set, not at the end.
		const offsetMs =
			input.offsetMs ??
			(
				await tx.parlumeMeetingSegment.aggregate({
					where: { sessionId: session.id },
					_max: { utteranceStartMs: true },
				})
			)._max.utteranceStartMs;
		await tx.parlumeMeetingSegment.createMany({
			data: {
				sessionId: session.id,
				projectId: session.projectId,
				organizationId: session.organizationId,
				userId: session.userId,
				dedupeKey: `confidential:${input.switch}:${now.getTime()}`,
				source: "EVENT",
				text: markerText(input.switch, by),
				speakerName: null,
				speakerId: null,
				utteranceStartMs: offsetMs ?? null,
				utteranceEndMs: offsetMs ?? null,
				confidential: on,
			},
			skipDuplicates: true,
		});
		return true;
	});
	if (changed) {
		parlumeLog("info", on ? "confidential.started" : "confidential.ended", {
			sessionId: session.id,
		});
	}
	return { changed, open: changed ? on : session.confidentialSince !== null };
}

/**
 * Marks a whole meeting confidential, or clears every confidential mark it
 * has, after it is over. Its segments follow.
 */
export async function markParlumeSessionConfidential(input: {
	sessionId: string;
	confidential: boolean;
	by: string | null;
}): Promise<void> {
	await db.$transaction([
		db.parlumeMeetingSession.update({
			where: { id: input.sessionId },
			data: {
				confidential: input.confidential,
				confidentialSince: null,
				confidentialBy: input.by,
			},
		}),
		db.parlumeMeetingSegment.updateMany({
			where: { sessionId: input.sessionId },
			data: { confidential: input.confidential },
		}),
	]);
}

/**
 * Tells the meeting chat the confidential part started or ended. The bridge
 * posts it as an ordinary post, so nothing is posted while anyone in the
 * meeting is unconfirmed or a guest. Best effort: the mark holds either way.
 */
export async function postParlumeConfidentialNotice(input: {
	sessionId: string;
	switch: ParlumeConfidentialSwitch;
	by: string | null;
}): Promise<boolean> {
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		return false;
	}
	const url = new URL(
		bridgeControlUrlForSession(settings.bridgeUrl, input.sessionId),
	);
	url.searchParams.set("action", "chat");
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${settings.serviceSecret}`,
			},
			body: JSON.stringify({
				message: parlumeConfidentialNotice(input),
				final: false,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		return response.ok;
	} catch (error) {
		parlumeLog("warn", "confidential.notice_failed", {
			sessionId: input.sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

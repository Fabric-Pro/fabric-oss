import { db } from "@repo/database";
import {
	Permissions,
	userHasProjectPermission,
} from "../../../orpc/procedures";
import {
	isParlumeConfidentialReader,
	withheldConfidentialParlumeSessions,
} from "./parlume-confidential";

/**
 * Who may read what a Parlume meeting said (its segments and transcript): the
 * person who invited Parlume, or turned on the auto-join that did, the
 * project's managers, and the project members the calendar invitation of an
 * automatic join named (the session's `inviteeEmails`). A manager holds
 * PROJECT_MEMBERS_MANAGE, the permission that invites and removes Parlume.
 * Only the inviter and managers delete it. Other project readers see the
 * session, its status and its notes.
 */
export function managesParlumeTranscripts(input: {
	projectId: string;
	userId: string;
}): Promise<boolean> {
	return userHasProjectPermission({
		userId: input.userId,
		projectId: input.projectId,
		permission: Permissions.PROJECT_MEMBERS_MANAGE,
	});
}

/** The inviter and the project's managers: they may also delete what it said. */
export async function canDeleteParlumeSession(input: {
	projectId: string;
	userId: string;
	inviterId: string;
}): Promise<boolean> {
	return (
		input.userId === input.inviterId ||
		(await managesParlumeTranscripts(input))
	);
}

/** The account's address, lower-cased as a session's invitees are. */
export async function parlumeReaderEmail(
	userId: string,
): Promise<string | null> {
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { email: true },
	});
	return user ? user.email.trim().toLowerCase() : null;
}

/** Whether a session's calendar invitation named this address. */
export function isParlumeInvitee(
	email: string | null,
	inviteeEmails: string[],
): boolean {
	return email !== null && inviteeEmails.includes(email);
}

/**
 * A confidential meeting's transcript is read only by someone who may read
 * the transcript at all and is also one of its verified attendees or a
 * project manager (`isParlumeConfidentialReader`): an inviter or invitee who
 * was not in the meeting loses it.
 */
export async function canReadParlumeTranscript(input: {
	projectId: string;
	userId: string;
	inviterId: string;
	inviteeEmails: string[];
	confidential: boolean;
	attendeeUserIds: string[];
}): Promise<boolean> {
	if (input.confidential && !(await isParlumeConfidentialReader(input))) {
		return false;
	}
	if (await canDeleteParlumeSession(input)) {
		return true;
	}
	return (
		input.inviteeEmails.length > 0 &&
		isParlumeInvitee(
			await parlumeReaderEmail(input.userId),
			input.inviteeEmails,
		)
	);
}

/** `deleted` once the transcript's text is gone, `withheld` from a reader who may not read it. */
export type ParlumeTranscriptAccess = "readable" | "withheld" | "deleted";

export const PARLUME_TRANSCRIPT_WITHHELD =
	"Only the people invited to this meeting, the person who invited Parlume and project managers can read this meeting's transcript, and a confidential meeting's only the people who were in it and project managers. Unless the meeting is confidential, its notes are on the Parlume page.";

/** What the transcript page says in place of a transcript this reader cannot see. */
export function parlumeTranscriptNotice(
	access: ParlumeTranscriptAccess | null,
): string | null {
	switch (access) {
		case null:
		case "readable":
			return null;
		case "withheld":
			return PARLUME_TRANSCRIPT_WITHHELD;
		case "deleted":
			return "This meeting's transcript was deleted. Its notes are on the Parlume page.";
		default: {
			const unreachable: never = access;
			return unreachable;
		}
	}
}

/** Null when the context is not a Parlume transcript. */
export async function resolveParlumeTranscriptAccess(input: {
	projectId: string;
	userId: string;
	contextId: string;
}): Promise<ParlumeTranscriptAccess | null> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			projectId: input.projectId,
			transcriptContextId: input.contextId,
		},
		select: {
			userId: true,
			inviteeEmails: true,
			transcriptDeletedAt: true,
			confidential: true,
			attendeeUserIds: true,
		},
	});
	if (!session) {
		return null;
	}
	if (session.transcriptDeletedAt) {
		return "deleted";
	}
	return (await canReadParlumeTranscript({
		projectId: input.projectId,
		userId: input.userId,
		inviterId: session.userId,
		inviteeEmails: session.inviteeEmails,
		confidential: session.confidential,
		attendeeUserIds: session.attendeeUserIds,
	}))
		? "readable"
		: "withheld";
}

/**
 * The ids of the project's Parlume transcripts this user may not read: those
 * of other people's meetings they were not invited to, unless they manage
 * the project, and those of confidential meetings they were not in.
 */
export async function withheldParlumeTranscriptIds(input: {
	projectId: string;
	userId: string;
}): Promise<Set<string>> {
	const email = await parlumeReaderEmail(input.userId);
	const [othersSessions, confidential] = await Promise.all([
		db.parlumeMeetingSession.findMany({
			where: {
				projectId: input.projectId,
				transcriptContextId: { not: null },
				userId: { not: input.userId },
				...(email ? { NOT: { inviteeEmails: { has: email } } } : {}),
			},
			select: { transcriptContextId: true },
		}),
		withheldConfidentialParlumeSessions(input),
	]);
	const withheld = new Set(confidential.contextIds);
	if (
		othersSessions.length === 0 ||
		(await managesParlumeTranscripts(input))
	) {
		return withheld;
	}
	for (const session of othersSessions) {
		if (session.transcriptContextId) {
			withheld.add(session.transcriptContextId);
		}
	}
	return withheld;
}

/** The project's contexts without the Parlume transcripts this user may not read. */
export async function withoutWithheldParlumeTranscripts<
	Context extends { id: string },
>(
	contexts: Context[],
	input: { projectId: string; userId: string },
): Promise<Context[]> {
	const withheld = await withheldParlumeTranscriptIds(input);
	return contexts.filter((context) => !withheld.has(context.id));
}

import {
	db,
	resolveOwnWorkflowIntegrationForProvider,
	resolveWorkflowIntegrationForProvider,
} from "@repo/database";
import {
	executeMicrosoftTeamsTool,
	extractChannelThreadId,
	isShortTeamsMeetingUrl,
} from "@repo/integrations/microsoft";
import { z } from "zod";
import { mayReadParlumeProject } from "./parlume-attendee-standing";
import { isParlumeExternalParticipant } from "./parlume-guests";
import { parlumeLog } from "./parlume-log";

// Teams names a signed-in participant by their Entra object id.
const SIGNED_IN_PARTICIPANT = /^8:orgid:([0-9a-f-]{36})$/i;

const teamsUserSchema = z.object({ emails: z.array(z.string()).max(2) });

// The connection records the account it was made with (Graph's `/me` id)
// as `oderId` when it is connected.
const connectedAccountSchema = z.object({ oderId: z.string().min(1) });

function findVerifiedUser(emails: string[]) {
	return emails.length
		? db.user.findFirst({
				where: {
					emailVerified: true,
					OR: emails.map((email) => ({
						email: { equals: email, mode: "insensitive" as const },
					})),
				},
				select: { id: true },
			})
		: Promise.resolve(null);
}

/**
 * The inviter, by the account of their own Microsoft Teams connection: read
 * from Fabric, with no Graph call, so an expired token cannot refuse them.
 */
async function isInviterAccount(
	session: { userId: string; organizationId: string },
	objectId: string,
): Promise<boolean> {
	const own = await resolveOwnWorkflowIntegrationForProvider(
		"MICROSOFT_GRAPH",
		session.userId,
		session.organizationId,
	);
	const connection = own
		? await db.workflowIntegration.findUnique({
				where: { id: own.id },
				select: { settings: true },
			})
		: null;
	const account = connectedAccountSchema.safeParse(connection?.settings);
	return (
		account.success &&
		account.data.oderId.toLowerCase() === objectId.toLowerCase()
	);
}

/** The Fabric account Teams' object id belongs to, through Graph. */
async function lookUpFabricUser(
	session: { userId: string; organizationId: string },
	objectId: string,
): Promise<string | null> {
	const integration = await resolveWorkflowIntegrationForProvider(
		"MICROSOFT_GRAPH",
		session.userId,
		session.organizationId,
	);
	if (!integration) {
		return null;
	}
	const { emails } = teamsUserSchema.parse(
		await executeMicrosoftTeamsTool(
			"parlume_channel",
			{ kind: "user", userId: objectId },
			session.userId,
			session.organizationId,
			integration.id,
		),
	);
	return (await findVerifiedUser(emails))?.id ?? null;
}

/**
 * Checks one participant Attendee reported and returns the Fabric account of
 * a confirmed project reader, or null for anyone Parlume must not answer in
 * front of. The inviter is known by their own Teams connection; anyone else
 * is looked up through the inviter's connection and matched to the Fabric
 * user with that verified address. Either way the account must hold project
 * read. Fails closed: anything that does not confirm them refuses them.
 */
export async function confirmParlumeAttendee(input: {
	session: { projectId: string; organizationId: string; userId: string };
	participant: { id: string; userId: string | null; name: string | null };
}): Promise<string | null> {
	const { session, participant } = input;
	if (isParlumeExternalParticipant(participant)) {
		return null;
	}
	const objectId = [participant.userId, participant.id]
		.map((id) => id?.match(SIGNED_IN_PARTICIPANT)?.[1])
		.find((id) => id !== undefined);
	if (!objectId) {
		return null;
	}
	try {
		const userId = (await isInviterAccount(session, objectId))
			? session.userId
			: await lookUpFabricUser(session, objectId);
		if (!userId) {
			return null;
		}
		const projectId = session.projectId;
		return (await mayReadParlumeProject({ userId, projectId }))
			? userId
			: null;
	} catch (error) {
		parlumeLog("warn", "attendee.lookup_failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Whether the meeting's chat may be a Teams channel's, which the channel's
 * members read whether or not they are in the meeting. Parlume cannot list
 * them (no channel-member scope is granted), so such a chat is never one
 * it can answer in. A short link not yet known to be an ordinary meeting
 * counts as one.
 */
export function isParlumeChannelMeeting(session: {
	meetingUrl: string | null;
	channelId: string | null;
	channelRootMessageId: string | null;
	channelChatStatus: string | null;
}): boolean {
	return Boolean(
		session.channelId ||
			session.channelRootMessageId ||
			(session.meetingUrl &&
				(extractChannelThreadId(session.meetingUrl) ||
					(isShortTeamsMeetingUrl(session.meetingUrl) &&
						session.channelChatStatus !== "ATTENDEE"))),
	);
}

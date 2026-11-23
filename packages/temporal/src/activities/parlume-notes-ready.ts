import { buildParlumePageUrl, db, hasProjectAccess } from "@repo/database";
import {
	NotificationCategory,
	NotificationType,
} from "@repo/database/prisma/generated/enums";
import {
	getNotificationPreferences,
	isCategoryEnabled,
} from "@repo/database/prisma/queries/notification-preferences";
import { logger } from "@repo/logs";
import { isMailConfigured, sendEmail } from "@repo/mail";

const UNNAMED_MEETING = "your meeting";

type Recipient = { id: string; email: string };

/**
 * The internal invitees who may read the meeting's transcript: the person who
 * invited Parlume and the members its calendar invitation named, each still a
 * reader of the project, and of a confidential meeting only those Fabric
 * confirmed in it. Guests have no Fabric account on the project, so they are
 * never among them. The same readers as `canReadParlumeTranscript` in
 * `@repo/api`, which this package cannot import; project managers who were
 * not invited read the notes on the page but are not told.
 */
async function notesRecipients(session: {
	projectId: string;
	organizationId: string;
	userId: string;
	inviteeEmails: string[];
	confidential: boolean;
	attendeeUserIds: string[];
}): Promise<Recipient[]> {
	const users = await db.user.findMany({
		where: {
			OR: [
				{ id: session.userId },
				...session.inviteeEmails.map((email) => ({
					email: { equals: email, mode: "insensitive" as const },
				})),
			],
		},
		select: { id: true, email: true },
	});
	const invited = users.filter(
		(user) =>
			user.id === session.userId ||
			session.inviteeEmails.includes(user.email.trim().toLowerCase()),
	);
	const inMeeting = session.confidential
		? invited.filter((user) => session.attendeeUserIds.includes(user.id))
		: invited;
	const readers = await Promise.all(
		inMeeting.map(async (user) =>
			(await hasProjectAccess(
				session.projectId,
				user.id,
				session.organizationId,
			))
				? user
				: null,
		),
	);
	return readers.filter((user): user is Recipient => user !== null);
}

async function notifyInApp(input: {
	recipient: Recipient;
	sessionId: string;
	projectId: string;
	organizationId: string;
	title: string;
	snippet: string;
	link: string;
}): Promise<void> {
	await db.notification.create({
		data: {
			userId: input.recipient.id,
			organizationId: input.organizationId,
			type: NotificationType.PARLUME_NOTES_READY,
			category: NotificationCategory.PROJECT,
			title: input.title,
			snippet: input.snippet,
			link: input.link,
			projectId: input.projectId,
			payload: { sessionId: input.sessionId, projectId: input.projectId },
			dedupeKey: `parlume-notes-ready:${input.sessionId}`,
		},
	});
}

/**
 * Tells a meeting's internal invitees who keep project notifications on that
 * Parlume's notes for it are ready: an in-app notification and an email with
 * a link to the Parlume page. Neither carries the notes, which
 * stay behind the link. Each meeting is announced once: the session's
 * `notesNotifiedAt` is claimed before anything is sent, so a retry or a
 * second notes run sends nothing, and a send that fails is dropped. Nothing
 * is sent until the notes are written.
 */
export async function notifyParlumeNotesReady(input: {
	sessionId: string;
}): Promise<{ notified: number }> {
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: input.sessionId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			inviteeEmails: true,
			confidential: true,
			attendeeUserIds: true,
			transcriptContextId: true,
			notesNotifiedAt: true,
			linkedMeeting: { select: { subject: true } },
			project: { select: { name: true } },
		},
	});
	if (!session?.transcriptContextId || session.notesNotifiedAt) {
		return { notified: 0 };
	}
	const context = await db.projectContext.findFirst({
		where: {
			id: session.transcriptContextId,
			projectId: session.projectId,
			organizationId: session.organizationId,
		},
		select: { metadata: true },
	});
	const metadata = context?.metadata;
	const notesReady =
		metadata !== null &&
		typeof metadata === "object" &&
		!Array.isArray(metadata) &&
		metadata.parlumeNotesStatus === "COMPLETED";
	if (!notesReady) {
		return { notified: 0 };
	}
	const claimed = await db.parlumeMeetingSession.updateMany({
		where: { id: session.id, notesNotifiedAt: null },
		data: { notesNotifiedAt: new Date() },
	});
	if (claimed.count === 0) {
		return { notified: 0 };
	}
	const recipients = await notesRecipients(session);
	if (recipients.length === 0) {
		return { notified: 0 };
	}
	const meetingName =
		session.linkedMeeting?.subject?.trim() || UNNAMED_MEETING;
	const projectName = session.project.name;
	const url = await buildParlumePageUrl(session);
	const title = `Meeting notes ready: ${meetingName}`;
	const snippet = `Parlume's notes for ${meetingName} in ${projectName} are on the Parlume page.`;
	const mail = isMailConfigured();
	let notified = 0;
	for (const recipient of recipients) {
		try {
			// Turning project notifications off opts out of both the row and
			// the email.
			const flags = await getNotificationPreferences(recipient.id);
			if (!isCategoryEnabled(flags, NotificationCategory.PROJECT)) {
				continue;
			}
			await notifyInApp({
				recipient,
				sessionId: session.id,
				projectId: session.projectId,
				organizationId: session.organizationId,
				title,
				snippet,
				link: new URL(url).pathname,
			});
			if (mail) {
				await sendEmail({
					to: recipient.email,
					templateId: "parlumeNotesReady",
					idempotencyKey: `parlume-notes-${session.id}-${recipient.id}`,
					context: { meetingName, projectName, url },
				});
			}
			notified += 1;
		} catch (error) {
			logger.warn("[Parlume] Notes-ready notice failed for a recipient", {
				sessionId: session.id,
				userId: recipient.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { notified };
}

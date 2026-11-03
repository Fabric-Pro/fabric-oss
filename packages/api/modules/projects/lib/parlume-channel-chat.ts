import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
	db,
	getProjectAccessContext,
	type Prisma,
	resolveWorkflowIntegrationForProvider,
} from "@repo/database";
import {
	assertChannelMessage,
	type ChannelDestination,
	type ChannelMessage,
	channelDestinationSchema,
	channelMessageSchema,
	executeMicrosoftTeamsTool,
	isShortTeamsMeetingUrl,
} from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	getParlumeBridgeSettings,
	sendParlumeChatMessage,
} from "./parlume-attendee";

const SUBSCRIPTION_TTL_MS = 45 * 60_000;
const SUBSCRIPTION_RENEW_MARGIN_MS = 10 * 60_000;
const UNAVAILABLE =
	"Channel chat unavailable. Reconnect Microsoft, grant channel message consent, and check channel membership.";
const sessionSelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	status: true,
	providerBotId: true,
	meetingUrl: true,
	joinedAt: true,
	hardStopAt: true,
	endedAt: true,
	captureStoppedAt: true,
	leaveRequestedAt: true,
	channelChatStatus: true,
	channelChatError: true,
	channelIntegrationId: true,
	channelTeamId: true,
	channelId: true,
	channelRootMessageId: true,
	channelTenantId: true,
	channelSubscriptionId: true,
	channelSubscriptionExpiresAt: true,
} as const;
type ChannelSession = Prisma.ParlumeMeetingSessionGetPayload<{
	select: typeof sessionSelect;
}>;

function channelDestination(session: ChannelSession): ChannelDestination {
	return channelDestinationSchema.parse({
		teamId: session.channelTeamId,
		channelId: session.channelId,
		rootMessageId: session.channelRootMessageId,
		tenantId: session.channelTenantId,
	});
}

function clientState(session: ChannelSession): string {
	const secret = getParlumeBridgeSettings()?.serviceSecret;
	if (!secret || !session.channelIntegrationId) {
		throw new Error("Channel chat bridge unavailable.");
	}
	return createHmac("sha256", secret)
		.update(
			JSON.stringify([
				"parlume-channel",
				session.id,
				session.organizationId,
				session.channelIntegrationId,
				channelDestination(session),
			]),
		)
		.digest("base64url");
}

async function active(session: ChannelSession): Promise<boolean> {
	if (
		session.status !== "ACTIVE" ||
		!session.providerBotId ||
		!session.joinedAt ||
		session.endedAt ||
		session.captureStoppedAt ||
		session.leaveRequestedAt ||
		!session.hardStopAt ||
		session.hardStopAt.getTime() <= Date.now()
	) {
		return false;
	}
	return (
		(await getProjectAccessContext(session.projectId, session.userId))
			?.organizationId === session.organizationId
	);
}

function graph(
	session: ChannelSession,
	operation: Record<string, unknown>,
): Promise<unknown> {
	if (!session.channelIntegrationId) {
		throw new Error(UNAVAILABLE);
	}
	return executeMicrosoftTeamsTool(
		"parlume_channel",
		operation,
		session.userId,
		session.organizationId,
		session.channelIntegrationId,
	);
}

async function getActiveChannelSession(
	sessionId: string,
): Promise<ChannelSession | null> {
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: sessionId },
		select: sessionSelect,
	});
	return session && (await active(session)) ? session : null;
}

async function unavailable(
	sessionId: string,
	message = UNAVAILABLE,
): Promise<void> {
	await db.parlumeMeetingSession.updateMany({
		where: { id: sessionId, status: "ACTIVE" },
		data: { channelChatStatus: "UNAVAILABLE", channelChatError: message },
	});
}

async function cleanup(session: ChannelSession): Promise<void> {
	await db.parlumeMeetingSession.updateMany({
		where: { id: session.id, channelChatStatus: { not: "ATTENDEE" } },
		data: { channelChatStatus: "STOPPED" },
	});
	if (session.channelSubscriptionId) {
		// Revoked connections may refuse deletion. Even then Graph expires this
		// subscription within its 45-minute lease; the webhook already rejects it.
		await graph(session, {
			kind: "unsubscribe",
			subscriptionId: session.channelSubscriptionId,
		});
		await db.parlumeMeetingSession.updateMany({
			where: {
				id: session.id,
				channelSubscriptionId: session.channelSubscriptionId,
			},
			data: {
				channelSubscriptionId: null,
				channelSubscriptionExpiresAt: null,
			},
		});
	}
}

/** One bounded lifecycle tick; a Temporal workflow calls it while the session lives. */
export async function reconcileParlumeChannelChat(
	sessionId: string,
	organizationId: string,
): Promise<{ continue: boolean; routingReady?: boolean }> {
	let session = await db.parlumeMeetingSession.findUnique({
		where: { id: sessionId },
		select: sessionSelect,
	});
	if (!session || session.organizationId !== organizationId) {
		return { continue: false };
	}
	if (session.channelChatStatus === "ATTENDEE") {
		return { continue: false, routingReady: await active(session) };
	}
	if (!(await active(session))) {
		try {
			await cleanup(session);
		} catch {
			// Revocation can also remove the authority to delete the remote
			// subscription. Its 45-minute lease is the bounded fallback.
			await db.parlumeMeetingSession.updateMany({
				where: { id: session.id },
				data: {
					channelChatStatus: "STOPPED",
					channelChatError:
						"Channel chat stopped. Remote notification subscription deletion could not be confirmed; its remaining lease is at most 45 minutes. No message content will be read or sent.",
				},
			});
		}
		return { continue: false };
	}
	try {
		if (!session.channelIntegrationId) {
			const integration = await resolveWorkflowIntegrationForProvider(
				"MICROSOFT_GRAPH",
				session.userId,
				session.organizationId,
			);
			if (!integration) {
				throw new Error(UNAVAILABLE);
			}
			await db.parlumeMeetingSession.updateMany({
				where: {
					id: session.id,
					status: "ACTIVE",
					channelIntegrationId: null,
				},
				data: { channelIntegrationId: integration.id },
			});
			session = await db.parlumeMeetingSession.findUniqueOrThrow({
				where: { id: session.id },
				select: sessionSelect,
			});
		}
		if (!session.channelRootMessageId) {
			if (!session.meetingUrl) {
				throw new Error(
					"Channel chat unavailable: the original meeting link is missing. Invite Parlume again with the full calendar link.",
				);
			}
			const destination = channelDestinationSchema.nullable().parse(
				await graph(session, {
					kind: "resolve",
					meetingUrl: session.meetingUrl,
				}),
			);
			if (!destination) {
				const saved = await db.parlumeMeetingSession.updateMany({
					where: {
						id: session.id,
						status: "ACTIVE",
						leaveRequestedAt: null,
						captureStoppedAt: null,
						hardStopAt: { gt: new Date() },
					},
					data: {
						channelChatStatus: "ATTENDEE",
						channelChatError: null,
					},
				});
				return {
					continue: false,
					routingReady:
						saved.count > 0 &&
						!!(await getActiveChannelSession(session.id)),
				};
			}
			await db.parlumeMeetingSession.updateMany({
				where: {
					id: session.id,
					status: "ACTIVE",
					channelIntegrationId: session.channelIntegrationId,
					channelRootMessageId: null,
				},
				data: {
					channelTeamId: destination.teamId,
					channelId: destination.channelId,
					channelRootMessageId: destination.rootMessageId,
					channelTenantId: destination.tenantId,
				},
			});
			session = await db.parlumeMeetingSession.findUniqueOrThrow({
				where: { id: session.id },
				select: sessionSelect,
			});
		}
		if (!(await active(session))) {
			await cleanup(session);
			return { continue: false };
		}
		// This also rechecks the pinned integration and current Graph permission,
		// even between renewals. No channel history is listed or replayed.
		await graph(session, {
			kind: "read",
			destination: channelDestination(session),
		});
		const settings = getParlumeBridgeSettings();
		if (!settings) {
			throw new Error("Channel chat bridge unavailable.");
		}
		if (
			!session.channelSubscriptionExpiresAt ||
			session.channelSubscriptionExpiresAt.getTime() - Date.now() <
				SUBSCRIPTION_RENEW_MARGIN_MS
		) {
			// Graph raises shorter leases to 45 minutes, even near hard stop.
			// Local authorization always ends at hard stop; cleanup deletes the lease.
			const expiresAt = new Date(Date.now() + SUBSCRIPTION_TTL_MS);
			const current =
				session.channelSubscriptionId &&
				session.channelSubscriptionExpiresAt &&
				session.channelSubscriptionExpiresAt.getTime() > Date.now();
			const endpoint = new URL(
				"/api/webhooks/parlume-channel",
				settings.callbackUrl,
			);
			endpoint.searchParams.set("session", session.id);
			const subscription = z
				.object({
					id: z.string(),
					expirationDateTime: z.iso.datetime({ offset: true }),
				})
				.parse(
					await graph(
						session,
						current
							? {
									kind: "renew",
									subscriptionId:
										session.channelSubscriptionId,
									expiresAt: expiresAt.toISOString(),
								}
							: {
									kind: "subscribe",
									destination: channelDestination(session),
									notificationUrl: endpoint.href,
									clientState: clientState(session),
									expiresAt: expiresAt.toISOString(),
								},
					),
				);
			const saved = await db.parlumeMeetingSession.updateMany({
				where: {
					id: session.id,
					status: "ACTIVE",
					leaveRequestedAt: null,
					captureStoppedAt: null,
				},
				data: {
					channelSubscriptionId: subscription.id,
					channelSubscriptionExpiresAt: new Date(
						subscription.expirationDateTime,
					),
					channelChatStatus: "READY",
					channelChatError: null,
				},
			});
			if (saved.count === 0) {
				await graph(session, {
					kind: "unsubscribe",
					subscriptionId: subscription.id,
				});
				return { continue: false };
			}
		} else {
			await db.parlumeMeetingSession.updateMany({
				where: { id: session.id, status: "ACTIVE" },
				data: { channelChatStatus: "READY", channelChatError: null },
			});
		}
		return {
			continue: true,
			routingReady: !!(await getActiveChannelSession(session.id)),
		};
	} catch (error) {
		const detail =
			error instanceof Error &&
			/^(Channel chat unavailable:|Channel chat unresolved:)/.test(
				error.message,
			)
				? error.message
				: UNAVAILABLE;
		if (
			!session.channelRootMessageId &&
			session.meetingUrl &&
			isShortTeamsMeetingUrl(session.meetingUrl)
		) {
			await db.parlumeMeetingSession.updateMany({
				where: { id: session.id, status: "ACTIVE" },
				data: {
					channelChatStatus: "UNRESOLVED",
					channelChatError: detail,
				},
			});
			return {
				continue: true,
				routingReady: !!(await getActiveChannelSession(session.id)),
			};
		}
		await unavailable(session.id, detail);
		return { continue: true };
	}
}

function plainText(message: ChannelMessage): string {
	const content =
		message.body.contentType === "html"
			? message.body.content
					.replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi, "\n")
					.replace(/<[^>]*>/g, "")
					.replace(/&#(\d+);/g, (_, code: string) => {
						const point = Number(code);
						return point >= 0 && point <= 0x10ffff
							? String.fromCodePoint(point)
							: "";
					})
					.replace(/&lt;/gi, "<")
					.replace(/&gt;/gi, ">")
					.replace(/&quot;/gi, '"')
					.replace(/&#39;|&apos;/gi, "'")
					.replace(/&nbsp;/gi, " ")
					.replace(/&amp;/gi, "&")
			: message.body.content;
	return content.trim().slice(0, 20_000);
}

function postDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function recordChannelDelivery(
	session: ChannelSession,
	postId: string,
	requestDigest: string,
	providerMessageId: string,
): Promise<void> {
	await db.parlumeChannelPost.updateMany({
		where: {
			id: postId,
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			providerMessageId,
			requestDigest,
			confirmedAt: null,
		},
		data: { confirmedAt: new Date() },
	});
}

async function confirmTaggedPost(
	session: ChannelSession,
	message: ChannelMessage,
): Promise<boolean> {
	const text = plainText(message);
	if (!/^\[P\d{1,6}\]/i.test(text)) {
		return true;
	}
	const post = await db.parlumeChannelPost.findFirst({
		where: {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			providerMessageId: message.id,
		},
		select: { id: true, requestDigest: true },
	});
	if (
		!post ||
		!text.includes("] Fabric Parlume: ") ||
		post.requestDigest !==
			postDigest(text.replace(/^(\[P\d{1,6}\]) Fabric Parlume: /, "$1 "))
	) {
		return false;
	}
	await recordChannelDelivery(
		session,
		post.id,
		post.requestDigest,
		message.id,
	);
	return true;
}

async function relay(
	session: ChannelSession,
	message: ChannelMessage,
): Promise<void> {
	const settings = getParlumeBridgeSettings();
	if (!settings || !(await getActiveChannelSession(session.id))) {
		throw new Error("Channel chat session is no longer active.");
	}
	await sendParlumeChatMessage({
		settings,
		sessionId: session.id,
		message: {
			id: `graph:${message.id}`,
			text: plainText(message),
			senderName: message.from?.user?.displayName ?? null,
			senderId: message.from?.user?.id ?? null,
			toBot: false,
			timestampMs: Date.parse(message.createdDateTime),
		},
	});
}

export const channelNotificationSchema = z.object({
	subscriptionId: z.string().min(1).max(256),
	clientState: z.string().min(1).max(128),
	tenantId: z.string().min(1).max(256),
	changeType: z.string().max(32),
	resource: z.string().max(2_048),
});

export const channelNotificationJobSchema = z.object({
	sessionId: z.string().min(1).max(128),
	organizationId: z.string().min(1).max(128),
	subscriptionId: z.string().min(1).max(256),
	replyId: z.string().regex(/^[^/\s]{1,120}$/),
	hardStopAt: z.iso.datetime(),
});
type ChannelNotificationJob = z.infer<typeof channelNotificationJobSchema>;

/** Extract identifiers, never a URL to fetch. Graph uses OData entity paths. */
export function channelReplyFromResource(
	resource: string,
	destination: ChannelDestination,
): string | null {
	const odata = resource.match(
		/^teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)\/replies\('([^']+)'\)$/,
	);
	const rest = resource.match(
		/^\/?teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)\/replies\/([^/]+)$/,
	);
	const match = odata ?? rest;
	if (!match) {
		return null;
	}
	try {
		const [, team, channel, root, reply] = match.map(decodeURIComponent);
		return team === destination.teamId &&
			channel === destination.channelId &&
			root === destination.rootMessageId &&
			/^[^/\s]{1,120}$/.test(reply)
			? reply
			: null;
	} catch {
		return null;
	}
}

/** Cheap authentication and resource filtering before durable enqueue. */
export async function prepareParlumeChannelNotifications(
	sessionId: string,
	notifications: z.infer<typeof channelNotificationSchema>[],
): Promise<ChannelNotificationJob[]> {
	const session = await getActiveChannelSession(sessionId);
	if (
		!session ||
		session.channelChatStatus !== "READY" ||
		!session.hardStopAt ||
		!session.channelSubscriptionExpiresAt ||
		session.channelSubscriptionExpiresAt.getTime() <= Date.now()
	) {
		return [];
	}
	const expectedBytes = Buffer.from(clientState(session));
	const destination = channelDestination(session);
	const seen = new Set<string>();
	const jobs: ChannelNotificationJob[] = [];
	for (const notification of notifications) {
		if (
			notification.subscriptionId !== session.channelSubscriptionId ||
			notification.tenantId !== session.channelTenantId ||
			notification.changeType !== "created"
		) {
			continue;
		}
		const providedBytes = Buffer.from(notification.clientState);
		if (
			providedBytes.length !== expectedBytes.length ||
			!timingSafeEqual(providedBytes, expectedBytes)
		) {
			continue;
		}
		const replyId = channelReplyFromResource(
			notification.resource,
			destination,
		);
		if (!replyId || seen.has(replyId)) {
			continue;
		}
		seen.add(replyId);
		jobs.push({
			sessionId: session.id,
			organizationId: session.organizationId,
			subscriptionId: notification.subscriptionId,
			replyId,
			hardStopAt: session.hardStopAt.toISOString(),
		});
	}
	return jobs;
}

/** Runs only after durable enqueue; every attempt repeats lifecycle/access checks. */
export async function deliverParlumeChannelNotification(
	job: ChannelNotificationJob,
): Promise<void> {
	const session = await getActiveChannelSession(job.sessionId);
	if (
		!session ||
		session.organizationId !== job.organizationId ||
		session.channelChatStatus !== "READY" ||
		session.channelSubscriptionId !== job.subscriptionId ||
		!session.channelSubscriptionExpiresAt ||
		session.channelSubscriptionExpiresAt.getTime() <= Date.now() ||
		Date.parse(job.hardStopAt) <= Date.now()
	) {
		return;
	}
	const destination = channelDestination(session);
	const replyId = job.replyId;
	const message = channelMessageSchema.parse(
		await graph(session, { kind: "read", destination, replyId }),
	);
	assertChannelMessage(message, destination, replyId);
	const created = Date.parse(message.createdDateTime);
	if (
		created < (session.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
		created > Date.now() + 30_000 ||
		created >= (session.hardStopAt?.getTime() ?? 0)
	) {
		return;
	}
	if (!(await confirmTaggedPost(session, message))) {
		return;
	}
	await relay(session, message);
}

/** Returns only after an exact created reply has been read back and relayed. */
export async function sendParlumeChannelPost(
	sessionId: string,
	text: string,
): Promise<void> {
	const session = await getActiveChannelSession(sessionId);
	if (
		!session ||
		session.channelChatStatus !== "READY" ||
		!session.channelSubscriptionExpiresAt ||
		session.channelSubscriptionExpiresAt.getTime() <= Date.now()
	) {
		throw new Error(UNAVAILABLE);
	}
	const tag = text.match(/^\[(P\d{1,6})\]\s*/)?.[1];
	if (!tag) {
		throw new Error("A channel post requires a Parlume delivery tag.");
	}
	const requestDigest = postDigest(text);
	const scope = {
		sessionId: session.id,
		projectId: session.projectId,
		organizationId: session.organizationId,
		userId: session.userId,
		tag,
	};
	const destination = channelDestination(session);
	await graph(session, { kind: "read", destination });
	if (!(await getActiveChannelSession(session.id))) {
		throw new Error("Channel chat session is no longer active.");
	}
	// createMany's conflict handling makes the durable claim atomic; a retry
	// never repeats a POST whose response may have been lost.
	const claim = await db.parlumeChannelPost.createMany({
		data: { ...scope, requestDigest },
		skipDuplicates: true,
	});
	let post = await db.parlumeChannelPost.findUniqueOrThrow({
		where: { sessionId_tag: { sessionId: session.id, tag } },
	});
	if (post.requestDigest !== requestDigest) {
		throw new Error(
			"Parlume post tag already belongs to a different message.",
		);
	}
	if (claim.count > 0) {
		if (!(await getActiveChannelSession(session.id))) {
			await db.parlumeChannelPost.deleteMany({
				where: { id: post.id, providerMessageId: null },
			});
			throw new Error("Channel chat session is no longer active.");
		}
		const result = z
			.object({ messageId: z.string().min(1).max(120) })
			.parse(
				await graph(session, {
					kind: "send",
					sessionId: session.id,
					destination,
					text: text.replace(
						/^(\[P\d{1,6}\])\s*/,
						"$1 Fabric Parlume: ",
					),
				}),
			);
		post = await db.parlumeChannelPost.update({
			where: { id: post.id },
			data: { providerMessageId: result.messageId },
		});
	}
	if (!post.providerMessageId) {
		throw new Error(
			"Channel post outcome is unknown. Check the meeting thread before retrying with a new post.",
		);
	}
	const message = channelMessageSchema.parse(
		await graph(session, {
			kind: "read",
			destination,
			replyId: post.providerMessageId,
		}),
	);
	assertChannelMessage(message, destination, post.providerMessageId);
	if (
		post.requestDigest !==
		postDigest(
			plainText(message).replace(
				/^(\[P\d{1,6}\]) Fabric Parlume: /,
				"$1 ",
			),
		)
	) {
		throw new Error(
			"The created channel reply does not match the Parlume post.",
		);
	}
	await recordChannelDelivery(
		session,
		post.id,
		post.requestDigest,
		message.id,
	);
	await relay(session, message);
}

import { z } from "zod";
import { resolveChannelIdentity } from "./channel-identity";
import type { GraphFetch } from "./stream-transcript";

const GRAPH = "https://graph.microsoft.com/v1.0";
const id = z.string().min(1).max(256);
export const channelDestinationSchema = z.object({
	teamId: id,
	channelId: id,
	rootMessageId: id,
	tenantId: id,
});
export type ChannelDestination = z.infer<typeof channelDestinationSchema>;

const subscriptionSchema = z.object({
	id,
	expirationDateTime: z.iso.datetime({ offset: true }),
});
export const channelMessageSchema = z.object({
	id,
	replyToId: id.nullish(),
	createdDateTime: z.iso.datetime({ offset: true }),
	deletedDateTime: z.string().nullish(),
	channelIdentity: z.object({ teamId: id, channelId: id }),
	from: z
		.object({
			user: z
				.object({ id, displayName: z.string().max(256).nullish() })
				.nullish(),
		})
		.nullish(),
	body: z.object({
		contentType: z.enum(["text", "html"]),
		content: z.string().max(100_000),
	}),
});
export type ChannelMessage = z.infer<typeof channelMessageSchema>;

export const parlumeChannelOperationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("resolve"),
		meetingUrl: z.string().max(8_192),
	}),
	z.object({
		kind: z.literal("canonical"),
		meetingUrl: z.string().max(8_192),
	}),
	z.object({
		kind: z.literal("read"),
		destination: channelDestinationSchema,
		replyId: id.optional(),
	}),
	z.object({
		kind: z.literal("subscribe"),
		destination: channelDestinationSchema,
		notificationUrl: z.url(),
		clientState: z.string().min(32).max(128),
		expiresAt: z.iso.datetime(),
	}),
	z.object({
		kind: z.literal("renew"),
		subscriptionId: id,
		expiresAt: z.iso.datetime(),
	}),
	z.object({ kind: z.literal("unsubscribe"), subscriptionId: id }),
	z.object({
		kind: z.literal("send"),
		sessionId: id,
		destination: channelDestinationSchema,
		text: z.string().min(1).max(4_200),
	}),
]);

function teamsUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			url.hostname === "teams.microsoft.com" &&
			!url.username &&
			!url.password &&
			!url.port
			? url
			: null;
	} catch {
		return null;
	}
}

export function parseChannelMeetingUrl(
	value: string,
): { channelId: string; rootMessageId: string } | null {
	const url = teamsUrl(value);
	const match = url?.pathname.match(
		/^\/l\/meetup-join\/([^/]+)\/(\d{1,32})\/?$/,
	);
	if (!match) {
		return null;
	}
	try {
		const channelId = decodeURIComponent(match[1]);
		return /^19:[^/\s]+@thread\.tacv2$/.test(channelId)
			? { channelId, rootMessageId: match[2] }
			: null;
	} catch {
		return null;
	}
}

export function isShortTeamsMeetingUrl(value: string): boolean {
	return /^\/meet\/\d{6,32}\/?$/.test(teamsUrl(value)?.pathname ?? "");
}

function isOrdinaryMeetingUrl(value: string): boolean {
	const url = teamsUrl(value);
	try {
		return (
			!!url &&
			/^\/l\/meetup-join\/19:[^/\s]+@thread\.v2\/\d+\/?$/.test(
				decodeURIComponent(url.pathname),
			)
		);
	} catch {
		return false;
	}
}

export function teamsMeetingIdentity(value: string): string | null {
	const channel = parseChannelMeetingUrl(value);
	if (channel) {
		return JSON.stringify([
			"channel",
			channel.channelId,
			channel.rootMessageId,
		]);
	}
	return isOrdinaryMeetingUrl(value)
		? JSON.stringify([
				"meeting",
				decodeURIComponent(new URL(value).pathname).replace(/\/$/, ""),
			])
		: null;
}

async function json(
	graphFetch: GraphFetch,
	path: string,
	options?: RequestInit,
): Promise<unknown> {
	const response = await graphFetch(`${GRAPH}${path}`, options);
	if (!response.ok) {
		throw new Error(
			`Microsoft channel chat unavailable (HTTP ${response.status}). Reconnect Microsoft, grant channel message consent, and check channel membership.`,
		);
	}
	return response.status === 204 ? null : response.json();
}

async function canonicalShortMeetingUrl(
	graphFetch: GraphFetch,
	meetingUrl: string,
): Promise<string> {
	const numericId = teamsUrl(meetingUrl)?.pathname.match(
		/^\/meet\/(\d{6,32})\/?$/,
	)?.[1];
	if (!numericId) {
		throw new Error(
			"Channel chat unresolved: the short Teams meeting ID is invalid.",
		);
	}
	const query = new URLSearchParams({
		$filter: `joinMeetingIdSettings/joinMeetingId eq '${numericId}'`,
	});
	const result = z
		.object({
			value: z
				.array(
					z.object({
						joinWebUrl: z.string().max(8_192),
						joinMeetingIdSettings: z.object({
							joinMeetingId: z.string(),
						}),
					}),
				)
				.max(20),
			"@odata.nextLink": z.string().optional(),
		})
		.parse(await json(graphFetch, `/me/onlineMeetings?${query}`));
	const destinations = new Map<string, string>();
	for (const meeting of result.value) {
		if (meeting.joinMeetingIdSettings.joinMeetingId !== numericId) {
			throw new Error(
				"Channel chat unresolved: Microsoft returned a different meeting ID.",
			);
		}
		const identity = teamsMeetingIdentity(meeting.joinWebUrl);
		if (!identity) {
			throw new Error(
				"Channel chat unresolved: Microsoft did not return a canonical Teams join link.",
			);
		}
		destinations.set(identity, meeting.joinWebUrl);
	}
	if (result["@odata.nextLink"] || destinations.size !== 1) {
		throw new Error(
			"Channel chat unresolved: Microsoft did not return one exact meeting thread for this numeric meeting ID. Meeting-bot chat remains available where Teams permits it. Use the full calendar meeting link to connect a channel thread.",
		);
	}
	return z.string().parse([...destinations.values()][0]);
}

export function channelMessagePath(
	destination: ChannelDestination,
	replyId?: string,
): string {
	return `/teams/${encodeURIComponent(destination.teamId)}/channels/${encodeURIComponent(destination.channelId)}/messages/${encodeURIComponent(destination.rootMessageId)}${replyId ? `/replies/${encodeURIComponent(replyId)}` : ""}`;
}

export function assertChannelMessage(
	message: ChannelMessage,
	destination: ChannelDestination,
	replyId?: string,
): void {
	if (
		message.id !== (replyId ?? destination.rootMessageId) ||
		message.channelIdentity.teamId !== destination.teamId ||
		message.channelIdentity.channelId !== destination.channelId ||
		(replyId
			? message.replyToId !== destination.rootMessageId
			: !!message.replyToId) ||
		message.deletedDateTime
	) {
		throw new Error(
			"Microsoft channel message does not match the bound meeting thread.",
		);
	}
}

/** Internal operations; deliberately absent from the agent tool catalog. */
export async function executeParlumeChannelOperation(
	graphFetch: GraphFetch,
	args: unknown,
): Promise<unknown> {
	const operation = parlumeChannelOperationSchema.parse(args);
	switch (operation.kind) {
		case "canonical":
			return {
				joinUrl: await canonicalShortMeetingUrl(
					graphFetch,
					operation.meetingUrl,
				),
			};
		case "resolve": {
			const meetingUrl = isShortTeamsMeetingUrl(operation.meetingUrl)
				? await canonicalShortMeetingUrl(
						graphFetch,
						operation.meetingUrl,
					)
				: operation.meetingUrl;
			if (isOrdinaryMeetingUrl(meetingUrl)) {
				return null;
			}
			const candidate = parseChannelMeetingUrl(meetingUrl);
			if (!candidate) {
				throw new Error(
					"Channel chat unavailable: this link does not identify an exact channel meeting thread.",
				);
			}
			const identity = await resolveChannelIdentity(
				graphFetch,
				GRAPH,
				candidate.channelId,
			);
			if (!identity) {
				throw new Error(
					"Channel chat unavailable: your Microsoft connection cannot access this channel.",
				);
			}
			const channel = z
				.object({ id, tenantId: id })
				.parse(
					await json(
						graphFetch,
						`/teams/${encodeURIComponent(identity.teamId)}/channels/${encodeURIComponent(identity.channelId)}?$select=id,tenantId`,
					),
				);
			if (channel.id !== candidate.channelId) {
				throw new Error("Microsoft channel identity mismatch.");
			}
			const destination = {
				...identity,
				rootMessageId: candidate.rootMessageId,
				tenantId: channel.tenantId,
			};
			const root = channelMessageSchema.parse(
				await json(graphFetch, channelMessagePath(destination)),
			);
			assertChannelMessage(root, destination);
			return destination;
		}
		case "read": {
			const message = channelMessageSchema.parse(
				await json(
					graphFetch,
					channelMessagePath(
						operation.destination,
						operation.replyId,
					),
				),
			);
			assertChannelMessage(
				message,
				operation.destination,
				operation.replyId,
			);
			return message;
		}
		case "send": {
			const result = z.object({ id }).parse(
				await json(
					graphFetch,
					`${channelMessagePath(operation.destination)}/replies`,
					{
						method: "POST",
						body: JSON.stringify({
							body: {
								contentType: "text",
								content: operation.text,
							},
						}),
					},
				),
			);
			return { messageId: result.id };
		}
		case "subscribe": {
			const url = new URL(operation.notificationUrl);
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.pathname !== "/api/webhooks/parlume-channel"
			) {
				throw new Error("Invalid channel notification endpoint.");
			}
			return subscriptionSchema.parse(
				await json(graphFetch, "/subscriptions", {
					method: "POST",
					body: JSON.stringify({
						changeType: "created",
						notificationUrl: url.href,
						resource: `/teams/${operation.destination.teamId}/channels/${operation.destination.channelId}/messages`,
						includeResourceData: false,
						clientState: operation.clientState,
						expirationDateTime: operation.expiresAt,
					}),
				}),
			);
		}
		case "renew":
			return subscriptionSchema.parse(
				await json(
					graphFetch,
					`/subscriptions/${encodeURIComponent(operation.subscriptionId)}`,
					{
						method: "PATCH",
						body: JSON.stringify({
							expirationDateTime: operation.expiresAt,
						}),
					},
				),
			);
		case "unsubscribe": {
			const response = await graphFetch(
				`${GRAPH}/subscriptions/${encodeURIComponent(operation.subscriptionId)}`,
				{ method: "DELETE" },
			);
			if (!response.ok && response.status !== 404) {
				throw new Error(
					`Microsoft subscription cleanup failed (HTTP ${response.status}).`,
				);
			}
			return null;
		}
		default: {
			const exhaustive: never = operation;
			return exhaustive;
		}
	}
}

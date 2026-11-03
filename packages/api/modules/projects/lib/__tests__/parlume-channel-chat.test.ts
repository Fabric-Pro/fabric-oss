import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	update: vi.fn(),
	access: vi.fn(),
	integration: vi.fn(),
	graph: vi.fn(),
	relay: vi.fn(),
	claim: vi.fn(),
	post: vi.fn(),
	savePost: vi.fn(),
	findPost: vi.fn(),
	deletePost: vi.fn(),
	confirmPost: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: mocks.session,
			findUniqueOrThrow: mocks.session,
			updateMany: mocks.update,
		},
		parlumeChannelPost: {
			createMany: mocks.claim,
			findUniqueOrThrow: mocks.post,
			update: mocks.savePost,
			findFirst: mocks.findPost,
			deleteMany: mocks.deletePost,
			updateMany: mocks.confirmPost,
		},
	},
	getProjectAccessContext: mocks.access,
	resolveWorkflowIntegrationForProvider: mocks.integration,
}));
vi.mock("@repo/integrations/microsoft", async () => ({
	...(await import(
		"../../../../../integrations/src/microsoft/parlume-channel"
	)),
	executeMicrosoftTeamsTool: mocks.graph,
}));
vi.mock("../parlume-attendee", () => ({
	getParlumeBridgeSettings: () => ({
		serviceSecret: "example-service-secret",
		callbackUrl: "https://example.com/api/internal/parlume/callback",
	}),
	sendParlumeChatMessage: mocks.relay,
}));

import {
	channelReplyFromResource,
	deliverParlumeChannelNotification,
	prepareParlumeChannelNotifications,
	reconcileParlumeChannelChat,
	sendParlumeChannelPost,
} from "../parlume-channel-chat";

async function receiveParlumeChannelNotification(
	sessionId: string,
	notification: {
		subscriptionId: string;
		tenantId: string;
		clientState: string;
		changeType: string;
		resource: string;
	},
): Promise<void> {
	for (const job of await prepareParlumeChannelNotifications(sessionId, [
		notification,
	])) {
		await deliverParlumeChannelNotification(job);
	}
}

const destination = {
	teamId: "example-team",
	channelId: "19:example@thread.tacv2",
	rootMessageId: "1700000000000",
	tenantId: "example-tenant",
};
const now = new Date("2026-11-02T10:00:00Z");
const base = {
	id: "example-session",
	projectId: "example-project",
	organizationId: "example-org",
	userId: "example-user",
	providerBotId: "example-bot",
	status: "ACTIVE",
	meetingUrl: "https://teams.microsoft.com/meet/1234567890123",
	createdAt: now,
	joinedAt: now,
	hardStopAt: new Date(now.getTime() + 3_600_000),
	endedAt: null,
	captureStoppedAt: null,
	leaveRequestedAt: null,
	channelChatStatus: "READY",
	channelChatError: null,
	channelIntegrationId: "example-integration",
	channelTeamId: destination.teamId,
	channelId: destination.channelId,
	channelRootMessageId: destination.rootMessageId,
	channelTenantId: destination.tenantId,
	channelSubscriptionId: "example-subscription",
	channelSubscriptionExpiresAt: new Date(now.getTime() + 300_000),
};
const reply = {
	id: "1700000000010",
	replyToId: destination.rootMessageId,
	createdDateTime: now.toISOString(),
	channelIdentity: {
		teamId: destination.teamId,
		channelId: destination.channelId,
	},
	from: { user: { id: "example-user", displayName: "Example User" } },
	body: {
		contentType: "html",
		content: "<p>Hey Fabric, what changed &amp; why?</p>",
	},
};
const state = createHmac("sha256", "example-service-secret")
	.update(
		JSON.stringify([
			"parlume-channel",
			base.id,
			base.organizationId,
			base.channelIntegrationId,
			destination,
		]),
	)
	.digest("base64url");
const notification = {
	subscriptionId: base.channelSubscriptionId,
	tenantId: destination.tenantId,
	clientState: state,
	changeType: "created",
	resource: `teams('${destination.teamId}')/channels('${destination.channelId}')/messages('${destination.rootMessageId}')/replies('${reply.id}')`,
};
const text = "[P1] Current project status.";
const requestDigest = createHash("sha256").update(text).digest("hex");
const ownReply = {
	...reply,
	body: {
		contentType: "text",
		content: "[P1] Fabric Parlume: Current project status.",
	},
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(now);
	mocks.session.mockResolvedValue({ ...base });
	mocks.update.mockResolvedValue({ count: 1 });
	mocks.access.mockResolvedValue({ organizationId: base.organizationId });
	mocks.graph.mockResolvedValue(reply);
	mocks.claim.mockResolvedValue({ count: 1 });
	mocks.confirmPost.mockResolvedValue({ count: 1 });
	mocks.post.mockResolvedValue({
		id: "example-post",
		requestDigest,
		providerMessageId: null,
	});
});
afterEach(() => vi.useRealTimers());

describe("Parlume Graph channel contract", () => {
	it("authenticates and deduplicates a large metadata batch without reading message content", async () => {
		const jobs = await prepareParlumeChannelNotifications(
			base.id,
			Array.from({ length: 1_000 }, () => notification),
		);
		expect(jobs).toEqual([
			{
				sessionId: base.id,
				organizationId: base.organizationId,
				subscriptionId: base.channelSubscriptionId,
				replyId: reply.id,
				hardStopAt: base.hardStopAt.toISOString(),
			},
		]);
		expect(mocks.graph).not.toHaveBeenCalled();
		expect(JSON.stringify(jobs)).not.toContain(notification.clientState);
	});
	it("rechecks revocation and stop between enqueue and durable delivery", async () => {
		const [job] = await prepareParlumeChannelNotifications(base.id, [
			notification,
		]);
		mocks.access.mockResolvedValue(null);
		await deliverParlumeChannelNotification(job);
		expect(mocks.graph).not.toHaveBeenCalled();
		mocks.access.mockResolvedValue({ organizationId: base.organizationId });
		mocks.session.mockResolvedValue({ ...base, status: "ENDED" });
		await deliverParlumeChannelNotification(job);
		expect(mocks.graph).not.toHaveBeenCalled();
	});
	it("uses only exact bound reply identifiers from notifications", () => {
		expect(
			channelReplyFromResource(notification.resource, destination),
		).toBe(reply.id);
		expect(
			channelReplyFromResource(
				notification.resource.replace(
					destination.rootMessageId,
					"another-root",
				),
				destination,
			),
		).toBeNull();
		expect(
			channelReplyFromResource(
				`https://example.com/${notification.resource}`,
				destination,
			),
		).toBeNull();
	});
	it("keeps the connected user's own questions, full bounded text and sender identity", async () => {
		await receiveParlumeChannelNotification(base.id, notification);
		expect(mocks.graph).toHaveBeenCalledWith(
			"parlume_channel",
			{ kind: "read", destination, replyId: reply.id },
			base.userId,
			base.organizationId,
			base.channelIntegrationId,
		);
		expect(mocks.relay).toHaveBeenCalledWith(
			expect.objectContaining({
				message: {
					id: `graph:${reply.id}`,
					text: "Hey Fabric, what changed & why?",
					senderName: "Example User",
					senderId: "example-user",
					timestampMs: now.getTime(),
					toBot: false,
				},
			}),
		);
	});
	it.each([
		{ clientState: "x".repeat(43) },
		{ tenantId: "other-tenant" },
		{ subscriptionId: "other-subscription" },
		{
			resource: notification.resource.replace(
				destination.rootMessageId,
				"other-root",
			),
		},
		{ changeType: "updated" },
	])(
		"rejects unauthenticated or unrelated notifications %j",
		async (override) => {
			await receiveParlumeChannelNotification(base.id, {
				...notification,
				...override,
			});
			expect(mocks.graph).not.toHaveBeenCalled();
			expect(mocks.relay).not.toHaveBeenCalled();
		},
	);
	it.each([{ organizationId: "other-org" }, null])(
		"rejects revoked or cross-tenant project access %j",
		async (access) => {
			mocks.access.mockResolvedValue(access);
			await receiveParlumeChannelNotification(base.id, notification);
			expect(mocks.graph).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ status: "ENDED" },
		{ leaveRequestedAt: now },
		{ captureStoppedAt: now },
		{ hardStopAt: now },
		{ channelSubscriptionExpiresAt: now },
	])(
		"does not capture after a stop or expired lease %j",
		async (override) => {
			mocks.session.mockResolvedValue({ ...base, ...override });
			await receiveParlumeChannelNotification(base.id, notification);
			expect(mocks.graph).not.toHaveBeenCalled();
		},
	);
	it("never replays recurring history or future messages", async () => {
		for (const createdDateTime of [
			new Date(now.getTime() - 1).toISOString(),
			new Date(now.getTime() + 31_000).toISOString(),
		]) {
			mocks.graph.mockResolvedValue({ ...reply, createdDateTime });
			await receiveParlumeChannelNotification(base.id, notification);
		}
		expect(mocks.relay).not.toHaveBeenCalled();
	});
	it("propagates a failed relay for Graph redelivery using the same stable ID", async () => {
		mocks.relay.mockRejectedValueOnce(new Error("Bridge down"));
		await expect(
			receiveParlumeChannelNotification(base.id, notification),
		).rejects.toThrow("Bridge down");
		await receiveParlumeChannelNotification(base.id, notification);
		expect(mocks.relay.mock.calls[0][0].message.id).toBe(
			mocks.relay.mock.calls[1][0].message.id,
		);
	});
	it("suppresses forged and overlapping-session P-tags unless the exact Graph message belongs to this session", async () => {
		mocks.graph.mockResolvedValue(ownReply);
		mocks.findPost.mockResolvedValue(null);
		await receiveParlumeChannelNotification(base.id, notification);
		expect(mocks.relay).not.toHaveBeenCalled();
		expect(mocks.confirmPost).not.toHaveBeenCalled();
		expect(mocks.findPost).toHaveBeenCalledWith({
			where: {
				sessionId: base.id,
				projectId: base.projectId,
				organizationId: base.organizationId,
				userId: base.userId,
				providerMessageId: reply.id,
			},
			select: { id: true, requestDigest: true },
		});
		mocks.findPost.mockResolvedValue({ id: "example-post", requestDigest });
		await receiveParlumeChannelNotification(base.id, notification);
		expect(mocks.relay).toHaveBeenCalledTimes(1);
		expect(mocks.confirmPost).toHaveBeenCalledTimes(1);
		mocks.graph.mockResolvedValue({
			...ownReply,
			body: {
				contentType: "text",
				content: "[P1] Fabric Parlume: Forged text",
			},
		});
		await receiveParlumeChannelNotification(base.id, notification);
		expect(mocks.relay).toHaveBeenCalledTimes(1);
		expect(mocks.confirmPost).toHaveBeenCalledTimes(1);
	});
	it("rechecks the pinned integration and surfaces consent loss without switching to Attendee", async () => {
		mocks.graph.mockRejectedValue(new Error("Forbidden"));
		expect(
			await reconcileParlumeChannelChat(base.id, base.organizationId),
		).toEqual({ continue: true });
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					channelChatStatus: "UNAVAILABLE",
				}),
			}),
		);
		expect(mocks.integration).not.toHaveBeenCalled();
	});
	it("renews an active subscription and tears it down after end or access revocation", async () => {
		mocks.session.mockResolvedValue({
			...base,
			channelSubscriptionExpiresAt: new Date(now.getTime() + 60_000),
		});
		mocks.graph.mockResolvedValueOnce(reply).mockResolvedValueOnce({
			id: base.channelSubscriptionId,
			expirationDateTime: new Date(now.getTime() + 300_000).toISOString(),
		});
		await reconcileParlumeChannelChat(base.id, base.organizationId);
		expect(mocks.graph.mock.calls[1][1]).toEqual({
			kind: "renew",
			subscriptionId: base.channelSubscriptionId,
			expiresAt: new Date(now.getTime() + 45 * 60_000).toISOString(),
		});
		mocks.session.mockResolvedValue({ ...base, status: "ENDED" });
		expect(
			await reconcileParlumeChannelChat(base.id, base.organizationId),
		).toEqual({ continue: false });
		expect(mocks.graph).toHaveBeenLastCalledWith(
			"parlume_channel",
			{ kind: "unsubscribe", subscriptionId: base.channelSubscriptionId },
			base.userId,
			base.organizationId,
			base.channelIntegrationId,
		);
	});
	it("refuses lifecycle calls from another organization", async () => {
		expect(
			await reconcileParlumeChannelChat(base.id, "another-org"),
		).toEqual({ continue: false });
		expect(mocks.graph).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("routes an exactly resolved ordinary short invitation to Attendee", async () => {
		mocks.session.mockResolvedValue({
			...base,
			channelRootMessageId: null,
			channelChatStatus: "PENDING",
		});
		mocks.graph.mockResolvedValue(null);
		expect(
			await reconcileParlumeChannelChat(base.id, base.organizationId),
		).toEqual({ continue: false, routingReady: true });
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { channelChatStatus: "ATTENDEE", channelChatError: null },
			}),
		);
	});
	it("preserves ordinary meeting-bot capability while warning about unresolved short-link channel support", async () => {
		mocks.session.mockResolvedValue({
			...base,
			channelRootMessageId: null,
			channelChatStatus: "PENDING",
		});
		mocks.graph.mockRejectedValue(
			new Error("Channel chat unresolved: use the full calendar link."),
		);
		await reconcileParlumeChannelChat(base.id, base.organizationId);
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					channelChatStatus: "UNRESOLVED",
					channelChatError:
						"Channel chat unresolved: use the full calendar link.",
				},
			}),
		);
	});
	it("sends exactly to the verified root as attributed Parlume and relays an actual read-back", async () => {
		mocks.graph
			.mockResolvedValueOnce(reply)
			.mockResolvedValueOnce({ messageId: reply.id })
			.mockResolvedValueOnce(ownReply);
		mocks.savePost.mockResolvedValue({
			id: "example-post",
			requestDigest,
			providerMessageId: reply.id,
		});
		await sendParlumeChannelPost(base.id, text);
		expect(mocks.graph.mock.calls[1]).toEqual([
			"parlume_channel",
			{
				kind: "send",
				sessionId: base.id,
				destination,
				text: "[P1] Fabric Parlume: Current project status.",
			},
			base.userId,
			base.organizationId,
			base.channelIntegrationId,
		]);
		expect(mocks.relay.mock.calls[0][0].message.text).toBe(
			"[P1] Fabric Parlume: Current project status.",
		);
		expect(mocks.confirmPost).toHaveBeenCalledWith({
			where: {
				id: "example-post",
				sessionId: base.id,
				projectId: base.projectId,
				organizationId: base.organizationId,
				userId: base.userId,
				providerMessageId: reply.id,
				requestDigest,
				confirmedAt: null,
			},
			data: { confirmedAt: now },
		});
	});
	it("does not repeat a duplicate tagged send, but can retry its read-back relay", async () => {
		mocks.claim.mockResolvedValue({ count: 0 });
		mocks.post.mockResolvedValue({
			id: "example-post",
			requestDigest,
			providerMessageId: reply.id,
		});
		mocks.graph.mockResolvedValue(ownReply);
		await sendParlumeChannelPost(base.id, text);
		await sendParlumeChannelPost(base.id, text);
		expect(
			mocks.graph.mock.calls.some(
				([, operation]) => operation.kind === "send",
			),
		).toBe(false);
		expect(mocks.relay).toHaveBeenCalledTimes(2);
	});
	it("never retries an ambiguous POST response under the same tag", async () => {
		mocks.graph
			.mockResolvedValueOnce(reply)
			.mockRejectedValueOnce(new Error("HTTP 502"));
		await expect(sendParlumeChannelPost(base.id, text)).rejects.toThrow(
			"HTTP 502",
		);
		mocks.claim.mockResolvedValue({ count: 0 });
		mocks.graph.mockResolvedValue(reply);
		await expect(sendParlumeChannelPost(base.id, text)).rejects.toThrow(
			"outcome is unknown",
		);
		expect(mocks.confirmPost).not.toHaveBeenCalled();
		expect(
			mocks.graph.mock.calls.filter(
				([, operation]) => operation.kind === "send",
			),
		).toHaveLength(1);
	});
	it("a failed preflight remains retryable and produces exactly one subsequent POST", async () => {
		mocks.graph.mockRejectedValueOnce(new Error("GET unavailable"));
		await expect(sendParlumeChannelPost(base.id, text)).rejects.toThrow(
			"GET unavailable",
		);
		expect(mocks.claim).not.toHaveBeenCalled();
		mocks.graph
			.mockResolvedValueOnce(reply)
			.mockResolvedValueOnce({ messageId: reply.id })
			.mockResolvedValueOnce(ownReply);
		mocks.savePost.mockResolvedValue({
			id: "example-post",
			requestDigest,
			providerMessageId: reply.id,
		});
		await sendParlumeChannelPost(base.id, text);
		expect(
			mocks.graph.mock.calls.filter(
				([, operation]) => operation.kind === "send",
			),
		).toHaveLength(1);
	});
	it("does not confirm a stored provider ID when its exact read-back fails", async () => {
		mocks.graph
			.mockResolvedValueOnce(reply)
			.mockResolvedValueOnce({ messageId: reply.id })
			.mockRejectedValueOnce(new Error("Read-back unavailable"));
		mocks.savePost.mockResolvedValue({
			id: "example-post",
			requestDigest,
			providerMessageId: reply.id,
		});
		await expect(sendParlumeChannelPost(base.id, text)).rejects.toThrow(
			"Read-back unavailable",
		);
		expect(mocks.savePost).toHaveBeenCalled();
		expect(mocks.confirmPost).not.toHaveBeenCalled();
	});
	it.each([
		{ ...ownReply, replyToId: "different-root" },
		{ ...ownReply, id: "different-message" },
		{
			...ownReply,
			body: {
				contentType: "text",
				content: "[P1] Fabric Parlume: Different content",
			},
		},
	])("does not confirm an inexact reply: %j", async (message) => {
		mocks.claim.mockResolvedValue({ count: 0 });
		mocks.post.mockResolvedValue({
			id: "example-post",
			requestDigest,
			providerMessageId: reply.id,
		});
		mocks.graph.mockResolvedValueOnce(reply).mockResolvedValueOnce(message);
		await expect(sendParlumeChannelPost(base.id, text)).rejects.toThrow();
		expect(mocks.confirmPost).not.toHaveBeenCalled();
	});
	it("records owned notification evidence even when bridge relay fails", async () => {
		mocks.graph.mockResolvedValue(ownReply);
		mocks.findPost.mockResolvedValue({ id: "example-post", requestDigest });
		mocks.relay.mockRejectedValueOnce(new Error("Bridge down"));
		await expect(
			receiveParlumeChannelNotification(base.id, notification),
		).rejects.toThrow("Bridge down");
		expect(mocks.confirmPost).toHaveBeenCalledWith(
			expect.objectContaining({ data: { confirmedAt: now } }),
		);
		expect(mocks.confirmPost.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.relay.mock.invocationCallOrder[0],
		);
	});
	it("preserves the first historical observation across retries and later edits", async () => {
		let confirmedAt: Date | null = null;
		mocks.confirmPost.mockImplementation(
			async ({
				where,
				data,
			}: {
				where: { confirmedAt: null };
				data: { confirmedAt: Date };
			}) => {
				if (where.confirmedAt === null && confirmedAt === null) {
					confirmedAt = data.confirmedAt;
					return { count: 1 };
				}
				return { count: 0 };
			},
		);
		mocks.claim.mockResolvedValue({ count: 0 });
		mocks.post.mockResolvedValue({
			id: "example-post",
			requestDigest,
			providerMessageId: reply.id,
		});
		mocks.graph.mockResolvedValue(ownReply);
		mocks.relay.mockRejectedValueOnce(new Error("Bridge down"));
		await expect(sendParlumeChannelPost(base.id, text)).rejects.toThrow(
			"Bridge down",
		);
		vi.setSystemTime(new Date(now.getTime() + 1_000));
		await sendParlumeChannelPost(base.id, text);
		expect(confirmedAt).toEqual(now);
		mocks.graph.mockResolvedValue({
			...ownReply,
			body: { contentType: "text", content: "Edited later" },
		});
		await expect(sendParlumeChannelPost(base.id, text)).rejects.toThrow(
			"does not match",
		);
		expect(confirmedAt).toEqual(now);
		expect(mocks.confirmPost).toHaveBeenCalledTimes(2);
		expect(
			mocks.graph.mock.calls.some(
				([, operation]) => operation.kind === "send",
			),
		).toBe(false);
	});
});

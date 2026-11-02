// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyInbound: vi.fn(),
	findMany: vi.fn(),
	findDeployment: vi.fn(),
	ownerMember: vi.fn(),
	getSlackCredentials: vi.fn(),
	upsert: vi.fn(),
	findMapping: vi.fn(),
	start: vi.fn(),
	signal: vi.fn(),
	addSlackReaction: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isDeploymentOwnerCurrentMember: mocks.ownerMember,
	db: {
		agentDeployment: { findUnique: mocks.findDeployment },
		channelEventReceipt: { create: vi.fn() },
		agentDeploymentTrigger: {
			findMany: mocks.findMany,
			findFirst: vi.fn(),
		},
		channelThreadMapping: {
			upsert: mocks.upsert,
			findUnique: mocks.findMapping,
			update: vi.fn(),
		},
	},
}));
vi.mock("@repo/integrations", () => ({
	channelRegistry: { get: () => ({ verifyInbound: mocks.verifyInbound }) },
}));
vi.mock("@repo/integrations/slack", () => ({
	addSlackReaction: mocks.addSlackReaction,
	getSlackCredentials: mocks.getSlackCredentials,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: mocks.start,
			getHandle: () => ({ signal: mocks.signal }),
		},
	}),
}));
vi.mock("../../lib/channels/slack-monitor-fanout", () => ({
	fanoutSlackMonitorEvent: vi.fn(),
}));

import { NextRequest } from "next/server";
import { handleChannelInbound } from "../../lib/channels/inbound-handler";

const request = () =>
	new NextRequest("https://example.com/api/webhooks/channels/slack/events", {
		method: "POST",
		body: "{}",
	});
const row = (id: string, userId: string, organizationId: string | null) => ({
	id,
	userId,
	organizationId,
	deploymentId: `deployment-${id}`,
	config: { channel: "slack", chatIdPattern: "^T0EXAMPLE/C0EXAMPLE$" },
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.verifyInbound.mockResolvedValue({
		kind: "message",
		message: {
			externalEventId: "event-example",
			channelId: "T0EXAMPLE/C0EXAMPLE",
			teamId: "T0EXAMPLE",
			threadId: "thread-example",
			text: "hello",
			sender: "U0EXAMPLE",
			isDirect: false,
			occurredAt: "2026-01-01T00:00:00.000Z",
			messageKind: "app_mention",
		},
	});
	mocks.upsert.mockResolvedValue({ id: "mapping-example", status: "active" });
	mocks.findMapping.mockResolvedValue(null);
	mocks.findDeployment.mockResolvedValue({
		userId: "owner-example",
		organizationId: "example-org",
	});
	mocks.ownerMember.mockResolvedValue(true);
	mocks.getSlackCredentials.mockImplementation(async (userId: string) => ({
		teamId: userId === "attacker-example" ? "T0OTHER" : "T0EXAMPLE",
	}));
});

describe("Slack inbound trigger binding", () => {
	it("skips a spoofed trigger and dispatches the legitimate owner", async () => {
		mocks.findMany.mockResolvedValue([
			row("spoof-example", "attacker-example", "attacker-org"),
			row("legit-example", "owner-example", "example-org"),
		]);
		const res = await handleChannelInbound("slack", request());
		expect(res.status).toBe(200);
		expect((await res.json()).dispatched).toBe(true);
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					isActive: true,
					type: "CHANNEL_MESSAGE",
					slackTeamId: "T0EXAMPLE",
				},
				orderBy: { id: "asc" },
			}),
		);
		expect(mocks.upsert.mock.calls[0][0].create).toEqual(
			expect.objectContaining({
				userId: "owner-example",
				organizationId: "example-org",
				triggerId: "legit-example",
			}),
		);
		expect(mocks.start.mock.calls[0][1].args[0]).toEqual(
			expect.objectContaining({
				triggerId: "legit-example",
				userId: "owner-example",
				organizationId: "example-org",
			}),
		);
	});

	it("does not reuse a workflow from a previously spoofed thread mapping", async () => {
		mocks.findMany.mockResolvedValue([
			row("legit-example", "owner-example", "example-org"),
		]);
		mocks.findMapping.mockResolvedValue({ triggerId: "spoof-example" });
		mocks.upsert.mockImplementation(async (args) => ({
			id: "mapping-example",
			status: "active",
			triggerId: "legit-example",
			workflowId:
				args.update.workflowId === null
					? null
					: "workflow-spoof-example",
		}));
		await handleChannelInbound("slack", request());
		expect(mocks.upsert.mock.calls[0][0].update.workflowId).toBeNull();
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("does not dispatch when only a spoofed trigger matches", async () => {
		mocks.findMany.mockResolvedValue([
			row("spoof-example", "attacker-example", "attacker-org"),
		]);
		const res = await handleChannelInbound("slack", request());
		expect((await res.json()).dispatched).toBe(false);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("refuses a removed owner before starting a channel workflow", async () => {
		mocks.findMany.mockResolvedValue([
			row("legit-example", "owner-example", "example-org"),
		]);
		mocks.ownerMember.mockResolvedValue(false);
		const res = await handleChannelInbound("slack", request());
		expect((await res.json()).dispatched).toBe(false);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("refuses a trigger without an organization even when its owner has the team", async () => {
		mocks.findMany.mockResolvedValue([
			row("orphan-example", "owner-example", null),
		]);
		const res = await handleChannelInbound("slack", request());
		expect((await res.json()).dispatched).toBe(false);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("does not select a spoofed owner for an unmatched-message reaction", async () => {
		mocks.verifyInbound.mockResolvedValue({
			kind: "message",
			message: {
				externalEventId: "event-example",
				channelId: "T0EXAMPLE/C0EXAMPLE",
				teamId: "T0EXAMPLE",
				threadId: "thread-example",
				text: "hello",
				sender: "U0EXAMPLE",
				isDirect: false,
				occurredAt: "2026-01-01T00:00:00.000Z",
				messageKind: "app_mention",
				providerTs: "1700000000.000100",
			},
		});
		mocks.findMany.mockResolvedValue([
			row("spoof-example", "attacker-example", "attacker-org"),
		]);
		const res = await handleChannelInbound("slack", request());
		expect((await res.json()).dispatched).toBe(false);
		expect(mocks.addSlackReaction).not.toHaveBeenCalled();
	});

	it("does not dispatch when the owner's Slack connection cannot be read", async () => {
		mocks.findMany.mockResolvedValue([
			row("legit-example", "owner-example", "example-org"),
		]);
		mocks.getSlackCredentials.mockRejectedValue(new Error("unreadable"));
		const res = await handleChannelInbound("slack", request());
		expect((await res.json()).dispatched).toBe(false);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("refuses a malformed inbound team before querying triggers", async () => {
		mocks.verifyInbound.mockResolvedValue({
			kind: "message",
			message: {
				externalEventId: "event-example",
				channelId: "T0EXAMPLE.*/C0EXAMPLE",
				teamId: "T0EXAMPLE.*",
				threadId: "thread-example",
				text: "hello",
				sender: "U0EXAMPLE",
				isDirect: false,
				occurredAt: "2026-01-01T00:00:00.000Z",
				messageKind: "app_mention",
			},
		});
		const res = await handleChannelInbound("slack", request());
		expect((await res.json()).dispatched).toBe(false);
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("preserves non-Slack channel selection", async () => {
		mocks.verifyInbound.mockResolvedValue({
			kind: "message",
			message: {
				externalEventId: "event-example",
				channelId: "chat-example",
				threadId: "thread-example",
				text: "hello",
				sender: "user-example",
				isDirect: false,
				occurredAt: "2026-01-01T00:00:00.000Z",
			},
		});
		mocks.findMany.mockResolvedValue([
			{
				...row("telegram-example", "owner-example", "example-org"),
				config: { channel: "telegram" },
			},
		]);
		const res = await handleChannelInbound("telegram", request());
		expect((await res.json()).dispatched).toBe(true);
		expect(mocks.findMany.mock.calls[0][0].where).toEqual({
			isActive: true,
			type: "CHANNEL_MESSAGE",
		});
		expect(mocks.findMany.mock.calls[0][0].orderBy).toBeUndefined();
		expect(mocks.getSlackCredentials).not.toHaveBeenCalled();
	});
});

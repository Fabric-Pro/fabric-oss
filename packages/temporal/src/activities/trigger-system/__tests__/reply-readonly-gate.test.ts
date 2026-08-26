/**
 * Read-only mode reply gate for trigger-system reply
 * activities: a project-BOUND agent posts nothing to Slack (postToSlack) or
 * a channel adapter (postToChannel) while its project is in Read-only mode
 * (product decision 2026-07-23). Agents with no project binding reply
 * normally. The gate returns a non-throwing "skipped" result so the calling
 * workflow neither errors nor retries.
 */

import { beforeEach, expect, it, vi } from "vitest";

const isProjectReadOnly = vi.fn(async () => false);
const slackThreadMappingUpdateMany = vi.fn(async () => ({ count: 1 }));
const channelThreadMappingUpdateMany = vi.fn(async () => ({ count: 1 }));
const workflowIntegrationFindFirst = vi.fn();
vi.mock("@repo/database", () => ({
	isProjectReadOnly: (...a: unknown[]) => isProjectReadOnly(...(a as [])),
	hasProjectAccess: vi.fn(async () => true),
	db: {
		slackThreadMapping: {
			updateMany: (...a: unknown[]) =>
				slackThreadMappingUpdateMany(...(a as [])),
		},
		channelThreadMapping: {
			updateMany: (...a: unknown[]) =>
				channelThreadMappingUpdateMany(...(a as [])),
		},
		workflowIntegration: {
			findFirst: (...a: unknown[]) =>
				workflowIntegrationFindFirst(...(a as [])),
		},
	},
}));

const sendSlackMessage = vi.fn();
vi.mock("@repo/integrations/slack", () => ({
	sendSlackMessage: (...a: unknown[]) => sendSlackMessage(...a),
}));

const adapterSend = vi.fn();
const channelRegistryGet = vi.fn();
vi.mock("@repo/integrations", () => ({
	channelRegistry: { get: (...a: unknown[]) => channelRegistryGet(...a) },
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: () => JSON.stringify({ botToken: "t" }),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../agentic-loop/in-flight-tool-compaction", () => ({
	makeInFlightToolCompactor: () => undefined,
}));

import { postToChannel, postToSlack } from "../index";

beforeEach(() => {
	vi.clearAllMocks();
	isProjectReadOnly.mockResolvedValue(false);
	sendSlackMessage.mockResolvedValue({ ok: true, messageTs: "1.2" });
	channelRegistryGet.mockReturnValue({
		providerKey: "telegram",
		name: "Telegram",
		send: (...a: unknown[]) => adapterSend(...(a as [])),
	});
	adapterSend.mockResolvedValue({ ok: true, messageId: "m1" });
	workflowIntegrationFindFirst.mockResolvedValue({ credentials: "enc" });
});

// ============================================================================
// postToSlack
// ============================================================================

it("postToSlack: bound project in read-only mode → reply suppressed, external post never fires", async () => {
	isProjectReadOnly.mockResolvedValue(true);

	const result = await postToSlack({
		channel: "C1",
		message: "reply",
		threadTs: "1.1",
		slackTeamId: "T1",
		userId: "u1",
		organizationId: "org1",
		projectId: "proj-ro",
	});

	expect(result).toEqual({ success: true, skipped: true });
	expect(isProjectReadOnly).toHaveBeenCalledWith("proj-ro");
	expect(sendSlackMessage).not.toHaveBeenCalled();
	expect(slackThreadMappingUpdateMany).not.toHaveBeenCalled();
});

it("postToSlack: no project binding → posts normally without a read-only lookup", async () => {
	const result = await postToSlack({
		channel: "C1",
		message: "reply",
		threadTs: "1.1",
		slackTeamId: "T1",
		userId: "u1",
	});

	expect(result.success).toBe(true);
	expect(result.skipped).toBeUndefined();
	expect(isProjectReadOnly).not.toHaveBeenCalled();
	expect(sendSlackMessage).toHaveBeenCalledTimes(1);
});

it("postToSlack: bound project writable → posts normally", async () => {
	const result = await postToSlack({
		channel: "C1",
		message: "reply",
		threadTs: "1.1",
		slackTeamId: "T1",
		userId: "u1",
		projectId: "proj-rw",
	});

	expect(result.success).toBe(true);
	expect(result.skipped).toBeUndefined();
	expect(isProjectReadOnly).toHaveBeenCalledWith("proj-rw");
	expect(sendSlackMessage).toHaveBeenCalledTimes(1);
});

// ============================================================================
// postToChannel
// ============================================================================

it("postToChannel: bound project in read-only mode → reply suppressed, adapter never invoked", async () => {
	isProjectReadOnly.mockResolvedValue(true);

	const result = await postToChannel({
		channel: "telegram",
		channelId: "chat1",
		text: "reply",
		userId: "u1",
		projectId: "proj-ro",
	});

	expect(result).toEqual({ success: true, skipped: true });
	expect(isProjectReadOnly).toHaveBeenCalledWith("proj-ro");
	expect(adapterSend).not.toHaveBeenCalled();
	// Gate fires before adapter/credential resolution.
	expect(channelRegistryGet).not.toHaveBeenCalled();
});

it("postToChannel: no project binding → posts normally without a read-only lookup", async () => {
	const result = await postToChannel({
		channel: "telegram",
		channelId: "chat1",
		text: "reply",
		userId: "u1",
	});

	expect(result.success).toBe(true);
	expect(result.skipped).toBeUndefined();
	expect(isProjectReadOnly).not.toHaveBeenCalled();
	expect(adapterSend).toHaveBeenCalledTimes(1);
});

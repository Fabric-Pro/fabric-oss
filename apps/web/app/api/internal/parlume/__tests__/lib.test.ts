import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	sessionUpdateMany: vi.fn(),
	sessionUpdate: vi.fn(),
	segmentFindMany: vi.fn(),
	turnFindMany: vi.fn(),
	actionFindMany: vi.fn(),
	channelPostFindMany: vi.fn(),
	contextCreate: vi.fn(),
	workflowStart: vi.fn(),
	deleteProviderData: vi.fn(),
	getSettings: vi.fn(),
}));

vi.mock("@repo/database", () => {
	const parlumeMeetingSession = {
		findUnique: mocks.sessionFindUnique,
		updateMany: mocks.sessionUpdateMany,
		update: mocks.sessionUpdate,
	};
	return {
		db: {
			parlumeMeetingSession,
			parlumeMeetingSegment: {
				findMany: mocks.segmentFindMany,
			},
			parlumeMeetingTurn: { findMany: mocks.turnFindMany },
			parlumeAction: { findMany: mocks.actionFindMany },
			parlumeChannelPost: { findMany: mocks.channelPostFindMany },
			$transaction: (
				run: (tx: {
					projectContext: { create: typeof mocks.contextCreate };
					parlumeMeetingSession: typeof parlumeMeetingSession;
				}) => Promise<string>,
			) =>
				run({
					projectContext: { create: mocks.contextCreate },
					parlumeMeetingSession,
				}),
		},
		logAiUsageAsync: () => undefined,
	};
});

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee", () => ({
	deleteParlumeMeetingBotData: mocks.deleteProviderData,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-provider-settings", () => ({
	resolveParlumeAttendeeSettings: mocks.getSettings,
}));

import { finalizeParlumeSession } from "@repo/api/modules/projects/lib/parlume-finalization";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sessionFindUnique.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		providerBotId: "bot-1",
		status: "ACTIVE",
		joinedAt: new Date("2026-10-01T17:01:00Z"),
		transcriptContextId: null,
		providerDataDeletedAt: null,
		createdAt: new Date("2026-10-01T17:00:00Z"),
		memberSpeakerIds: [],
		guestSpeakerIds: [],
	});
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.segmentFindMany.mockResolvedValue([]);
	mocks.turnFindMany.mockResolvedValue([]);
	mocks.actionFindMany.mockResolvedValue([]);
	mocks.channelPostFindMany.mockResolvedValue([]);
	mocks.getSettings.mockResolvedValue({
		apiKey: "test-key",
		baseUrl: "https://attendee.example.com",
		teamsLoginMode: null,
		source: "environment",
	});
	mocks.deleteProviderData.mockResolvedValue(undefined);
});

describe("Parlume empty transcript finalization", () => {
	it("ends an empty meeting and deletes provider artifacts", async () => {
		await finalizeParlumeSession("session-1");

		expect(mocks.contextCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "ENDED",
					lastError: "No final speech segments were received.",
				}),
			}),
		);
		expect(mocks.deleteProviderData).toHaveBeenCalledWith({
			attendee: expect.objectContaining({ apiKey: "test-key" }),
			providerBotId: "bot-1",
		});
		expect(mocks.sessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					providerDataDeletedAt: expect.any(Date),
					callbackTokenDigest: null,
					webhookReceipts: { deleteMany: {} },
				},
			}),
		);
	});

	it("keeps the webhook token while Attendee's data is still to be deleted", async () => {
		mocks.deleteProviderData.mockRejectedValue(new Error("bot not ended"));

		await expect(finalizeParlumeSession("session-1")).rejects.toThrow(
			"bot not ended",
		);

		// The terminal webhook Attendee redelivers is what retries the
		// deletion, so it must still be accepted.
		expect(mocks.sessionUpdate).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ callbackTokenDigest: null }),
			}),
		);
	});
});

describe("Parlume transcript finalization", () => {
	it("tags the saved transcript with the Attendee provider, and never embeds it", async () => {
		mocks.segmentFindMany.mockResolvedValue([
			{
				text: "We decided to ship the draft.",
				source: "SPEECH",
				speakerName: "Dev One",
				utteranceStartMs: 0,
				utteranceEndMs: 2_000,
				createdAt: new Date("2026-10-01T18:00:00Z"),
			},
		]);
		mocks.contextCreate.mockResolvedValue({ id: "context-1" });
		mocks.workflowStart.mockResolvedValue(undefined);

		await finalizeParlumeSession("session-1");

		expect(mocks.contextCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: "MEETING_TRANSCRIPT",
					content:
						"Captured incoming speech:\nDev One: We decided to ship the draft.\n",
					metadata: {
						provider: "attendee",
						parlumeSessionId: "session-1",
						parlumeNotesStatus: "PENDING",
						parlumeChannelChatDelivery: {
							version: 1,
							sessionId: "session-1",
							projectId: "project-1",
							organizationId: "org-1",
							receipts: [],
							omittedCount: 0,
						},
					},
				}),
			}),
		);
		expect(mocks.workflowStart).not.toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.anything(),
		);
	});

	it("saves scoped responses and individual receipts without treating generated success as proof", async () => {
		mocks.turnFindMany.mockResolvedValue([
			{
				id: "turn-1",
				requestText: "Create the feature and update its task.",
				responseText: "Both changes succeeded.",
				status: "COMPLETED",
				interruptedAt: null,
			},
		]);
		mocks.actionFindMany.mockResolvedValue([
			{
				turnId: "turn-1",
				toolName: "fabric_create_story",
				status: "COMPLETED",
			},
			{
				turnId: "turn-1",
				toolName: "fabric_update_task",
				status: "FAILED",
			},
		]);
		mocks.contextCreate.mockResolvedValue({ id: "context-1" });

		await finalizeParlumeSession("session-1");

		const where = {
			sessionId: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
		};
		// A question asked on the Parlume page stays out of the record.
		const meetingTurn = { replyChannel: { not: "PAGE" } };
		expect(mocks.turnFindMany).toHaveBeenCalledWith({
			where: { ...where, ...meetingTurn },
			select: {
				id: true,
				requestText: true,
				responseText: true,
				status: true,
				interruptedAt: true,
			},
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			take: 10_001,
		});
		expect(mocks.actionFindMany).toHaveBeenCalledWith({
			where: { ...where, turn: meetingTurn },
			select: { turnId: true, toolName: true, status: true },
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			take: 10_001,
		});
		expect(mocks.channelPostFindMany).toHaveBeenCalledWith({
			where,
			select: { tag: true, confirmedAt: true },
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			take: 10_001,
		});
		const content = mocks.contextCreate.mock.calls[0][0].data.content;
		expect(content).toContain("Response: Both changes succeeded.");
		expect(content).toContain(
			"Action receipt: fabric_create_story — COMPLETED",
		);
		expect(content).toContain(
			"Action receipt: fabric_update_task — FAILED",
		);
		expect(content).toContain(
			"A COMPLETED request does not prove a Fabric mutation, channel chat delivery or audio playback.",
		);
		expect(content).toContain(
			"Only COMPLETED Fabric mutation receipts confirm their recorded mutation; other mutation statuses are unsuccessful or unconfirmed.",
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeNotesWorkflow",
			expect.objectContaining({
				args: [
					{
						sessionId: "session-1",
						organizationId: "org-1",
						userId: "user-1",
					},
				],
			}),
		);
	});

	it("keeps a completed chat response neutral when mutation and delivery proof are absent", async () => {
		mocks.turnFindMany.mockResolvedValue([
			{
				id: "turn-1",
				requestText: "Post the project status in chat.",
				responseText: "Posted it.",
				status: "COMPLETED",
				interruptedAt: null,
			},
		]);
		mocks.channelPostFindMany.mockResolvedValue([
			{ tag: "P1", confirmedAt: null },
		]);
		mocks.contextCreate.mockResolvedValue({ id: "context-1" });

		await finalizeParlumeSession("session-1");

		const content = mocks.contextCreate.mock.calls[0][0].data.content;
		expect(content).toContain("Fabric mutation receipts: none recorded.");
		expect(content).not.toContain("action success unconfirmed");
		expect(content).toContain(
			"P1: delivery not verified; this does not prove failure.",
		);
		expect(content).not.toContain("P1: exact Graph reply");
	});
});

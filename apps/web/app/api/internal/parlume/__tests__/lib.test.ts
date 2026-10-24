import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	sessionUpdateMany: vi.fn(),
	sessionUpdate: vi.fn(),
	segmentFindMany: vi.fn(),
	turnFindMany: vi.fn(),
	actionFindMany: vi.fn(),
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
	getParlumeBridgeSettings: mocks.getSettings,
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
		transcriptContextId: null,
		providerDataDeletedAt: null,
	});
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.segmentFindMany.mockResolvedValue([]);
	mocks.turnFindMany.mockResolvedValue([]);
	mocks.actionFindMany.mockResolvedValue([]);
	mocks.getSettings.mockReturnValue({ apiKey: "test-key" });
	mocks.deleteProviderData.mockResolvedValue(undefined);
});

describe("Parlume empty transcript finalization", () => {
	it("ends an empty meeting and deletes provider artifacts", async () => {
		await finalizeParlumeSession("session-1");

		expect(mocks.contextCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.sessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "ENDED",
					lastError: "No final speech segments were received.",
				}),
			}),
		);
		expect(mocks.deleteProviderData).toHaveBeenCalledWith({
			settings: { apiKey: "test-key" },
			providerBotId: "bot-1",
		});
		expect(mocks.sessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { providerDataDeletedAt: expect.any(Date) },
			}),
		);
	});
});

describe("Parlume transcript finalization", () => {
	it("tags the saved transcript and its embedding workflow with the Attendee provider", async () => {
		mocks.segmentFindMany.mockResolvedValue([
			{
				text: "We decided to ship the draft.",
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
					},
				}),
			}),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						contextId: "context-1",
						metadata: expect.objectContaining({
							provider: "attendee",
						}),
					}),
				],
			}),
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
		expect(mocks.turnFindMany).toHaveBeenCalledWith({
			where,
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
			where,
			select: { turnId: true, toolName: true, status: true },
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
			"A COMPLETED request does not prove action success or audio delivery.",
		);
		expect(content).toContain(
			"Only COMPLETED action receipts confirm success; all other action statuses are unsuccessful or unconfirmed.",
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
});

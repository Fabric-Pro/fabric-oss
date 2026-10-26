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
	recordUsage: vi.fn(),
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
			parlumeMeetingSegment: { findMany: mocks.segmentFindMany },
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

vi.mock("../parlume-attendee", () => ({
	deleteParlumeMeetingBotData: mocks.deleteProviderData,
}));

vi.mock("../parlume-provider-settings", () => ({
	resolveParlumeAttendeeSettings: mocks.getSettings,
}));

vi.mock("../parlume-log", () => ({ parlumeLog: () => undefined }));

vi.mock("../parlume-usage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../parlume-usage")>()),
	recordParlumeMeetingProviderUsage: mocks.recordUsage,
}));

import { finalizeParlumeSession } from "../parlume-finalization";

function storedSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		providerBotId: "bot-1",
		status: "JOINING",
		endReason: "START_FAILED",
		joinedAt: null,
		terminalCallbackAt: null,
		leaveRequestedAt: null,
		captureStoppedAt: null,
		finalizedAt: null,
		transcriptContextId: null,
		providerDataDeletedAt: null,
		createdAt: new Date("2026-10-01T17:00:00Z"),
		...overrides,
	};
}

const attendee = {
	apiKey: "test-key",
	baseUrl: "https://attendee.example.com",
	teamsLoginMode: null,
	source: "organization",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sessionFindUnique.mockResolvedValue(storedSession());
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.sessionUpdate.mockResolvedValue(undefined);
	mocks.segmentFindMany.mockResolvedValue([]);
	mocks.turnFindMany.mockResolvedValue([]);
	mocks.actionFindMany.mockResolvedValue([]);
	mocks.contextCreate.mockResolvedValue({ id: "context-1" });
	mocks.getSettings.mockResolvedValue(attendee);
	mocks.deleteProviderData.mockResolvedValue(undefined);
});

function storedTurn(overrides: Record<string, unknown> = {}) {
	return {
		id: "turn-1",
		requestText: "Create a feature for the release notes.",
		responseText: "The release notes feature is ready.",
		status: "COMPLETED",
		interruptedAt: null,
		...overrides,
	};
}

function savedContent(): string {
	return mocks.contextCreate.mock.calls[0][0].data.content;
}

describe("finalizeParlumeSession conversation records", () => {
	it("marks meeting chat lines among the speech they were sent during", async () => {
		mocks.segmentFindMany.mockResolvedValue([
			{
				text: "Where is the plan?",
				speakerName: "Alex",
				source: "SPEECH",
			},
			{
				text: "Here: https://example.com/plan",
				speakerName: "Sam",
				source: "CHAT",
			},
		]);
		mocks.turnFindMany.mockResolvedValue([]);
		mocks.actionFindMany.mockResolvedValue([]);

		await finalizeParlumeSession("session-1");

		expect(savedContent()).toContain(
			"Alex: Where is the plan?\n[chat] Sam: Here: https://example.com/plan\n",
		);
		expect(mocks.segmentFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				select: { text: true, speakerName: true, source: true },
			}),
		);
	});

	it("saves generated answers and completed receipts alongside incoming speech for notes", async () => {
		mocks.segmentFindMany.mockResolvedValue([
			{
				text: "Create a feature for the release notes.",
				speakerName: "Alex",
			},
			{ text: "Thank you.", speakerName: "Sam" },
		]);
		mocks.turnFindMany.mockResolvedValue([storedTurn()]);
		mocks.actionFindMany.mockResolvedValue([
			{
				turnId: "turn-1",
				toolName: "fabric_create_story",
				status: "COMPLETED",
			},
		]);

		await finalizeParlumeSession("session-1");

		const content = savedContent();
		expect(content).toContain("Captured incoming speech:\nAlex: Create");
		expect(content).toContain("\nSam: Thank you.\n");
		expect(content).toContain(
			"Recorded Fabric responses and action receipts:",
		);
		expect(content).toContain(
			"Request 1: Create a feature for the release notes.",
		);
		expect(content).toContain(
			"Response: The release notes feature is ready.",
		);
		expect(content).toContain(
			"Action receipt: fabric_create_story — COMPLETED",
		);
		expect(content.indexOf("Sam: Thank you.")).toBeLessThan(
			content.indexOf("Request 1:"),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeNotesWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ sessionId: "session-1" })],
			}),
		);
	});

	it("keeps failed, incomplete and interrupted records distinct from a generated success claim", async () => {
		mocks.turnFindMany.mockResolvedValue([
			storedTurn({ responseText: "All changes succeeded." }),
			storedTurn({
				id: "turn-2",
				requestText: "Next question?",
				status: "RUNNING",
				responseText: null,
				interruptedAt: new Date("2026-10-01T18:00:00Z"),
			}),
			storedTurn({
				id: "turn-3",
				requestText: "Last question?",
				status: "FAILED",
				responseText: "Partial reply.",
			}),
			storedTurn({ id: "turn-4", status: "PENDING", responseText: null }),
		]);
		const statuses = [
			"FAILED",
			"COMPLETED",
			"PROPOSED",
			"AWAITING_CONFIRMATION",
			"EXECUTING",
			"CANCELLED",
			"EXPIRED",
			"INVALIDATED",
			"OUTCOME_UNKNOWN",
		];
		mocks.actionFindMany.mockResolvedValue(
			statuses.map((status) => ({
				turnId: "turn-1",
				toolName: "fabric_update_task",
				status,
			})),
		);

		await finalizeParlumeSession("session-1");

		const content = savedContent();
		expect(content).toContain("Response: All changes succeeded.");
		for (const status of statuses) {
			expect(content).toContain(
				`Action receipt: fabric_update_task — ${status}`,
			);
		}
		expect(content).toContain(
			"A COMPLETED request does not prove action success or audio delivery.",
		);
		expect(content).toContain(
			"Only COMPLETED action receipts confirm success; all other action statuses are unsuccessful or unconfirmed.",
		);
		expect(content).toContain(
			"Request status: RUNNING\nPlayback interrupted: yes\nResponse: No response text recorded.",
		);
		expect(content).toContain("Request status: FAILED");
		expect(content).toContain("Request status: PENDING");
		expect(content.indexOf("Request 1:")).toBeLessThan(
			content.indexOf("Request 2:"),
		);
		expect(content.indexOf("Request 2:")).toBeLessThan(
			content.indexOf("Request 3:"),
		);
		expect(content.indexOf("— FAILED")).toBeLessThan(
			content.indexOf("— COMPLETED"),
		);
		expect(content).toContain(
			"Action receipts: none recorded (action success unconfirmed).",
		);
	});

	it("loads only bounded session, project and organization records without raw tool payloads", async () => {
		mocks.turnFindMany.mockResolvedValue([storedTurn()]);
		mocks.actionFindMany.mockResolvedValue([
			{
				turnId: "turn-1",
				toolName: "fabric_create_story",
				status: "FAILED",
				arguments: { privatePayload: "synthetic-argument-marker" },
				outcome: "synthetic-outcome-marker",
			},
		]);

		await finalizeParlumeSession("session-1");

		const where = {
			sessionId: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
		};
		for (const query of [
			mocks.segmentFindMany,
			mocks.turnFindMany,
			mocks.actionFindMany,
		]) {
			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({ where, take: 10_001 }),
			);
		}
		expect(mocks.turnFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			}),
		);
		expect(mocks.actionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				select: { turnId: true, toolName: true, status: true },
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			}),
		);
		expect(mocks.turnFindMany.mock.calls[0][0].select).toEqual({
			id: true,
			requestText: true,
			responseText: true,
			status: true,
			interruptedAt: true,
		});
		expect(savedContent()).not.toContain("synthetic-argument-marker");
		expect(savedContent()).not.toContain("synthetic-outcome-marker");
	});

	it("associates receipts with their own request even when action creation order differs", async () => {
		mocks.turnFindMany.mockResolvedValue([
			storedTurn(),
			storedTurn({ id: "turn-2", requestText: "Update the task." }),
		]);
		mocks.actionFindMany.mockResolvedValue([
			{
				turnId: "turn-2",
				toolName: "fabric_update_task",
				status: "FAILED",
			},
			{
				turnId: "turn-1",
				toolName: "fabric_create_story",
				status: "COMPLETED",
			},
		]);

		await finalizeParlumeSession("session-1");

		const content = savedContent();
		const secondRequest = content.indexOf("Request 2:");
		expect(content.indexOf("fabric_create_story — COMPLETED")).toBeLessThan(
			secondRequest,
		);
		expect(content.indexOf("fabric_update_task — FAILED")).toBeGreaterThan(
			secondRequest,
		);
	});

	it("refuses to drop a receipt without a matching scoped request", async () => {
		mocks.actionFindMany.mockResolvedValue([
			{
				turnId: "turn-1",
				toolName: "fabric_update_task",
				status: "FAILED",
			},
		]);

		await expect(finalizeParlumeSession("session-1")).rejects.toThrow(
			"no matching scoped request",
		);
		expect(mocks.contextCreate).not.toHaveBeenCalled();
		expect(mocks.deleteProviderData).not.toHaveBeenCalled();
	});

	it("retains an answered request when no incoming segments remain, without saving it twice", async () => {
		mocks.turnFindMany.mockResolvedValue([storedTurn()]);
		await finalizeParlumeSession("session-1");
		expect(savedContent()).toContain("The release notes feature is ready.");
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "ENDED",
				transcriptContextId: "context-1",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
				providerDataDeletedAt: new Date("2026-10-01T18:00:06Z"),
			}),
		);
		await finalizeParlumeSession("session-1");
		expect(mocks.contextCreate).toHaveBeenCalledOnce();
		expect(mocks.turnFindMany).toHaveBeenCalledOnce();
		expect(mocks.recordUsage).toHaveBeenCalledOnce();
		expect(mocks.deleteProviderData).toHaveBeenCalledOnce();
	});

	it("says a session that left the lobby heard nothing", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({ joinedAt: new Date("2026-10-01T17:06:00Z") }),
		);
		await finalizeParlumeSession("session-1");
		expect(mocks.contextCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastError: "No final speech segments were received.",
				}),
			}),
		);
		expect(mocks.recordUsage).toHaveBeenCalledOnce();
		expect(mocks.deleteProviderData).toHaveBeenCalledOnce();
	});

	it("records no speech error for a session that never got past the lobby", async () => {
		await finalizeParlumeSession("session-1");

		const ended = mocks.sessionUpdateMany.mock.calls
			.map(([args]) => args.data)
			.find((data) => data.status === "ENDED");
		expect(ended).toBeDefined();
		expect(ended).not.toHaveProperty("lastError");
		expect(mocks.recordUsage).toHaveBeenCalledOnce();
	});

	it("applies the Context size limit to incoming speech and appended records together", async () => {
		mocks.segmentFindMany.mockResolvedValue([
			{ text: "x".repeat(999_900), speakerName: null },
		]);
		mocks.turnFindMany.mockResolvedValue([storedTurn()]);
		await expect(finalizeParlumeSession("session-1")).rejects.toThrow(
			"exceeds the storage limit",
		);
		expect(mocks.contextCreate).not.toHaveBeenCalled();
		expect(mocks.deleteProviderData).not.toHaveBeenCalled();
	});

	it.each(["segments", "turns", "actions"])(
		"refuses to silently truncate excess %s",
		async (kind) => {
			const query = {
				segments: mocks.segmentFindMany,
				turns: mocks.turnFindMany,
				actions: mocks.actionFindMany,
			}[kind];
			query.mockResolvedValue(
				Array.from({ length: 10_001 }, () => ({
					text: "hello",
					...storedTurn(),
					turnId: "turn-1",
					toolName: "fabric_create_story",
				})),
			);
			await expect(finalizeParlumeSession("session-1")).rejects.toThrow(
				"record limit",
			);
			expect(mocks.contextCreate).not.toHaveBeenCalled();
			expect(mocks.recordUsage).not.toHaveBeenCalled();
		},
	);
});

describe("finalizeParlumeSession provider usage", () => {
	it("records the bot's time once, even when a failed session is finalized again", async () => {
		await finalizeParlumeSession("session-1", { preserveFailure: true });

		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
		expect(mocks.recordUsage).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-1", success: false }),
		);
		// The claim, then the finish that still holds it.
		expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(2);

		// The watchdog reads the session after the first finalization finished.
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "FAILED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
				providerDataDeletedAt: new Date("2026-10-01T18:00:06Z"),
			}),
		);
		await expect(
			finalizeParlumeSession("session-1", { preserveFailure: true }),
		).resolves.toBeUndefined();

		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
		expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(2);
		expect(mocks.deleteProviderData).toHaveBeenCalledTimes(1);
	});

	it("still retries a provider data deletion that a finished finalization left owing", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "FAILED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
			}),
		);

		await finalizeParlumeSession("session-1", { preserveFailure: true });

		expect(mocks.recordUsage).not.toHaveBeenCalled();
		expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
		expect(mocks.getSettings).toHaveBeenCalledWith("org-1");
		expect(mocks.deleteProviderData).toHaveBeenCalledWith({
			attendee,
			providerBotId: "bot-1",
		});
	});

	it("refuses to delete provider data when no Attendee settings resolve", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "FAILED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
			}),
		);
		mocks.getSettings.mockResolvedValue(null);

		await expect(
			finalizeParlumeSession("session-1", { preserveFailure: true }),
		).rejects.toThrow("provider configuration is unavailable");
		expect(mocks.deleteProviderData).not.toHaveBeenCalled();
	});

	it("ends a bot stopped in the lobby with its stop reason and bills it from the invite", async () => {
		// Stopped while waiting to be admitted: no stream ever opened, so no
		// segments, no turns, no join time and stream generation 0.
		const createdAt = new Date("2026-10-26T17:50:00Z");
		const leaveRequestedAt = new Date("2026-10-26T17:54:05Z");
		const terminalCallbackAt = new Date("2026-10-26T17:54:40Z");
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "LEAVING",
				endReason: "STOPPED",
				createdAt,
				leaveRequestedAt,
				terminalCallbackAt,
			}),
		);

		await finalizeParlumeSession("session-1", {
			expectedStreamGeneration: 0,
		});

		const [claim, finish] = mocks.sessionUpdateMany.mock.calls;
		expect(claim[0].where).toEqual(
			expect.objectContaining({ id: "session-1", streamGeneration: 0 }),
		);
		expect(finish[0].data).toEqual(
			expect.objectContaining({
				status: "ENDED",
				finalizedAt: expect.any(Date),
				endedAt: expect.any(Date),
			}),
		);
		expect(finish[0].data).not.toHaveProperty("endReason");
		expect(mocks.contextCreate).not.toHaveBeenCalled();
		expect(mocks.recordUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				requestedAt: createdAt,
				joinedAt: null,
				endedAt: terminalCallbackAt,
				success: true,
			}),
		);
		expect(mocks.deleteProviderData).toHaveBeenCalledOnce();
	});

	it("records nothing for a session that already ended", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "ENDED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
				providerDataDeletedAt: new Date("2026-10-01T18:00:06Z"),
			}),
		);

		await finalizeParlumeSession("session-1");

		expect(mocks.recordUsage).not.toHaveBeenCalled();
		expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses to claim a failed session that finalized after it was read", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({ status: "FAILED" }),
		);
		// By the time the claim runs, a concurrent finalization has finished.
		mocks.sessionUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			finalizeParlumeSession("session-1", { preserveFailure: true }),
		).rejects.toThrow("already in progress");

		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						{ status: "FAILED", finalizedAt: null },
					]),
				}),
			}),
		);
		expect(mocks.recordUsage).not.toHaveBeenCalled();
	});

	it("claims a failed session only when asked to preserve the failure", async () => {
		await finalizeParlumeSession("session-1");

		const [{ where }] = mocks.sessionUpdateMany.mock.calls[0];
		expect(JSON.stringify(where.OR)).not.toContain('"FAILED"');
	});

	it("bills the bot from the invite and transcription from the verified stream", async () => {
		const createdAt = new Date("2026-10-01T17:00:00Z");
		const joinedAt = new Date("2026-10-01T17:06:00Z");
		const terminalCallbackAt = new Date("2026-10-01T17:36:00Z");
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({ createdAt, joinedAt, terminalCallbackAt }),
		);

		await finalizeParlumeSession("session-1");

		expect(mocks.recordUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				requestedAt: createdAt,
				joinedAt,
				endedAt: terminalCallbackAt,
			}),
		);
	});

	it.each([
		["an empty session", false],
		["a session with a transcript", true],
	])(
		"records nothing when %s was claimed again while it stalled",
		async (_label, withTranscript) => {
			if (withTranscript) {
				mocks.turnFindMany.mockResolvedValue([storedTurn()]);
			}
			// The claim succeeds; by the finish, a later attempt holds it.
			mocks.sessionUpdateMany
				.mockResolvedValueOnce({ count: 1 })
				.mockResolvedValueOnce({ count: 0 });

			await expect(finalizeParlumeSession("session-1")).rejects.toThrow(
				"taken over by a later attempt",
			);

			const [, finish] = mocks.sessionUpdateMany.mock.calls;
			const claimedAt =
				mocks.sessionUpdateMany.mock.calls[0][0].data
					.finalizationStartedAt;
			expect(finish[0].where).toEqual({
				id: "session-1",
				status: "FINALIZING",
				finalizationStartedAt: claimedAt,
			});
			expect(mocks.recordUsage).not.toHaveBeenCalled();
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expect(mocks.deleteProviderData).not.toHaveBeenCalled();
		},
	);
});

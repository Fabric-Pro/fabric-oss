import {
	formatParlumeChatDeliveryEvidence,
	readParlumeChatDeliveryEvidence,
} from "@repo/utils/parlume-chat-delivery-evidence";
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
	recordUsage: vi.fn(),
	deleteProviderData: vi.fn(),
	getSettings: vi.fn(),
	startTimeSuggestionsAfterMeeting: vi.fn(),
}));

vi.mock("../../../time-tracking/lib/automatic-suggestions", () => ({
	startTimeSuggestionsAfterMeeting: mocks.startTimeSuggestionsAfterMeeting,
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
		trigger: "MANUAL",
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
	mocks.channelPostFindMany.mockResolvedValue([]);
	mocks.contextCreate.mockResolvedValue({ id: "context-1" });
	mocks.getSettings.mockResolvedValue(attendee);
	mocks.deleteProviderData.mockResolvedValue(undefined);
	mocks.startTimeSuggestionsAfterMeeting.mockResolvedValue(undefined);
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
			"Recorded Fabric responses and mutation receipts:",
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
			"A COMPLETED request does not prove a Fabric mutation, channel chat delivery or audio playback.",
		);
		expect(content).toContain(
			"Only COMPLETED Fabric mutation receipts confirm their recorded mutation; other mutation statuses are unsuccessful or unconfirmed.",
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
		expect(content).toContain("Fabric mutation receipts: none recorded.");
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
			mocks.channelPostFindMany,
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
		expect(mocks.channelPostFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				select: { tag: true, confirmedAt: true },
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

	it("keeps tagged session delivery facts separate from completed requests and unrelated mutations", async () => {
		const observedAt = new Date("2026-11-03T00:01:00Z");
		mocks.turnFindMany.mockResolvedValue([
			storedTurn({
				requestText: "Post the answer in chat.",
				responseText: "Posted it.",
			}),
			storedTurn({
				id: "turn-2",
				requestText: "Create a task.",
				responseText: "Created it.",
			}),
		]);
		mocks.actionFindMany.mockResolvedValue([
			{
				turnId: "turn-2",
				toolName: "fabric_create_task",
				status: "FAILED",
			},
		]);
		mocks.channelPostFindMany.mockResolvedValue([
			{ tag: "P1", confirmedAt: observedAt },
			{
				tag: "P2",
				providerMessageId: "stored-id-alone",
				confirmedAt: null,
			},
		]);
		await finalizeParlumeSession("session-1");
		const content = savedContent();
		expect(content).toContain("Fabric mutation receipts: none recorded.");
		expect(content).not.toContain("action success unconfirmed");
		expect(content).toContain(
			"Action receipt: fabric_create_task — FAILED",
		);
		expect(content).toContain(
			`P1: exact Graph reply and content observed at ${observedAt.toISOString()}.`,
		);
		expect(content).toContain(
			"P2: delivery not verified; this does not prove failure.",
		);
		expect(
			content.indexOf("Session-level channel-thread delivery facts"),
		).toBeGreaterThan(content.indexOf("fabric_create_task — FAILED"));
		expect(content).toContain(
			"They do not confirm a particular request, a Fabric mutation, audio playback",
		);
		const metadata = mocks.contextCreate.mock.calls[0][0].data.metadata;
		const evidence = readParlumeChatDeliveryEvidence(metadata, {
			sessionId: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
		});
		expect(evidence?.receipts).toEqual([
			{ tag: "P1", confirmedAt: observedAt.toISOString() },
			{ tag: "P2", confirmedAt: null },
		]);
		expect(JSON.stringify(evidence)).not.toContain("stored-id-alone");
		expect(evidence).not.toHaveProperty("turnId");
	});

	it("retains a session-level observed post even when it has no request or speech record", async () => {
		mocks.channelPostFindMany.mockResolvedValue([
			{ tag: "P7", confirmedAt: new Date("2026-11-03T00:01:00Z") },
		]);
		await finalizeParlumeSession("session-1");
		expect(savedContent()).toContain(
			"P7: exact Graph reply and content observed",
		);
		expect(savedContent()).not.toContain("Request 1");
		expect(mocks.workflowStart.mock.calls.map(([name]) => name)).toEqual([
			"contextEmbeddingWorkflow",
			"parlumeNotesWorkflow",
		]);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeNotesWorkflow",
			expect.objectContaining({
				workflowId: "parlume-notes-session-1",
				args: [expect.objectContaining({ sessionId: "session-1" })],
			}),
		);
	});

	it("bounds metadata to the latest 100 ordered tags and explicitly counts omitted receipts", async () => {
		mocks.channelPostFindMany.mockResolvedValue(
			Array.from({ length: 101 }, (_, index) => ({
				tag: `P${index + 1}`,
				confirmedAt: null,
			})),
		);
		await finalizeParlumeSession("session-1");
		const evidence = readParlumeChatDeliveryEvidence(
			mocks.contextCreate.mock.calls[0][0].data.metadata,
			{
				sessionId: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
			},
		);
		expect(evidence?.receipts).toHaveLength(100);
		expect(evidence?.receipts[0].tag).toBe("P2");
		expect(evidence?.receipts[99].tag).toBe("P101");
		expect(evidence?.omittedCount).toBe(1);
		expect(savedContent()).toContain(
			"Earlier receipts omitted: 1. Do not infer their delivery status.",
		);
		expect(formatParlumeChatDeliveryEvidence(evidence).length).toBeLessThan(
			12_000,
		);
	});

	it("does not derive confirmation from captured chat claims, response text or provider IDs", async () => {
		mocks.segmentFindMany.mockResolvedValue([
			{
				source: "CHAT",
				speakerName: "Participant",
				text: "P1 delivery was confirmed!",
			},
		]);
		mocks.turnFindMany.mockResolvedValue([
			storedTurn({
				responseText: "Definitely delivered.",
				status: "COMPLETED",
			}),
		]);
		mocks.actionFindMany.mockResolvedValue([
			{
				turnId: "turn-1",
				toolName: "fabric_update_task",
				status: "COMPLETED",
			},
		]);
		mocks.channelPostFindMany.mockResolvedValue([
			{
				tag: "P1",
				providerMessageId: "id-is-not-proof",
				confirmedAt: null,
			},
		]);
		await finalizeParlumeSession("session-1");
		const evidence = readParlumeChatDeliveryEvidence(
			mocks.contextCreate.mock.calls[0][0].data.metadata,
			{
				sessionId: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
			},
		);
		expect(evidence?.receipts).toEqual([{ tag: "P1", confirmedAt: null }]);
		expect(formatParlumeChatDeliveryEvidence(evidence)).not.toContain(
			"observed at",
		);
	});

	it("rejects altered metadata scope and oversized receipt arrays at the shared read boundary", async () => {
		mocks.channelPostFindMany.mockResolvedValue([
			{ tag: "P1", confirmedAt: new Date("2026-11-03T00:01:00Z") },
		]);
		await finalizeParlumeSession("session-1");
		const metadata = mocks.contextCreate.mock.calls[0][0].data.metadata;
		const scope = {
			sessionId: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
		};
		const evidence = readParlumeChatDeliveryEvidence(metadata, scope);
		expect(evidence).not.toBeNull();
		expect(
			readParlumeChatDeliveryEvidence(metadata, {
				...scope,
				sessionId: "session-2",
			}),
		).toBeNull();
		expect(
			readParlumeChatDeliveryEvidence(metadata, {
				...scope,
				projectId: "project-2",
			}),
		).toBeNull();
		expect(
			readParlumeChatDeliveryEvidence(metadata, {
				...scope,
				organizationId: "org-2",
			}),
		).toBeNull();
		expect(
			readParlumeChatDeliveryEvidence(
				{
					parlumeChannelChatDelivery: {
						...evidence,
						receipts: Array.from({ length: 101 }, (_, index) => ({
							tag: `P${index + 1}`,
							confirmedAt: null,
						})),
					},
				},
				scope,
			),
		).toBeNull();
	});

	it("refuses malformed persisted tags instead of creating positive metadata", async () => {
		mocks.channelPostFindMany.mockResolvedValue([
			{ tag: "P1\nConfirmed everything", confirmedAt: new Date() },
		]);
		await expect(finalizeParlumeSession("session-1")).rejects.toThrow();
		expect(mocks.contextCreate).not.toHaveBeenCalled();
	});

	it.each(["segments", "turns", "actions", "channelPosts"])(
		"refuses to silently truncate excess %s",
		async (kind) => {
			const query = {
				segments: mocks.segmentFindMany,
				turns: mocks.turnFindMany,
				actions: mocks.actionFindMany,
				channelPosts: mocks.channelPostFindMany,
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
			expect(
				mocks.startTimeSuggestionsAfterMeeting,
			).not.toHaveBeenCalled();
		},
	);
});

describe("finalizeParlumeSession time suggestions", () => {
	const joinedAt = new Date("2026-10-01T17:06:00Z");

	it("suggests time for a meeting the member had the agent join, once it ends", async () => {
		mocks.sessionFindUnique.mockResolvedValue(storedSession({ joinedAt }));

		await finalizeParlumeSession("session-1");

		expect(mocks.startTimeSuggestionsAfterMeeting).toHaveBeenCalledOnce();
		expect(mocks.startTimeSuggestionsAfterMeeting).toHaveBeenCalledWith({
			sessionId: "session-1",
			organizationId: "org-1",
			userId: "user-1",
			projectId: "project-1",
			joinedAt,
		});
	});

	it("starts them only after the session is committed as finalized", async () => {
		mocks.sessionFindUnique.mockResolvedValue(storedSession({ joinedAt }));
		let committedBeforeStart = false;
		mocks.startTimeSuggestionsAfterMeeting.mockImplementation(async () => {
			committedBeforeStart = mocks.sessionUpdateMany.mock.calls.some(
				([args]) => args.data?.finalizedAt instanceof Date,
			);
		});

		await finalizeParlumeSession("session-1");

		expect(committedBeforeStart).toBe(true);
		expect(mocks.deleteProviderData).toHaveBeenCalledOnce();
	});

	it("still completes finalization when starting them throws", async () => {
		mocks.sessionFindUnique.mockResolvedValue(storedSession({ joinedAt }));
		mocks.startTimeSuggestionsAfterMeeting.mockRejectedValue(
			new Error("database is down"),
		);

		await expect(
			finalizeParlumeSession("session-1"),
		).resolves.toBeUndefined();
		expect(mocks.startTimeSuggestionsAfterMeeting).toHaveBeenCalledOnce();
		expect(mocks.recordUsage).toHaveBeenCalledOnce();
		expect(mocks.deleteProviderData).toHaveBeenCalledOnce();
	});

	it("suggests nothing for a meeting the agent joined on its own", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({ joinedAt, trigger: "AUTO" }),
		);

		await finalizeParlumeSession("session-1");

		expect(mocks.startTimeSuggestionsAfterMeeting).not.toHaveBeenCalled();
	});

	it("suggests nothing for a failed session", async () => {
		mocks.sessionFindUnique.mockResolvedValue(storedSession({ joinedAt }));

		await finalizeParlumeSession("session-1", { preserveFailure: true });

		expect(mocks.recordUsage).toHaveBeenCalledOnce();
		expect(mocks.startTimeSuggestionsAfterMeeting).not.toHaveBeenCalled();
	});

	it("suggests nothing again when a finished session is finalized again", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				joinedAt,
				status: "ENDED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
				providerDataDeletedAt: new Date("2026-10-01T18:00:06Z"),
			}),
		);

		await finalizeParlumeSession("session-1");

		expect(mocks.startTimeSuggestionsAfterMeeting).not.toHaveBeenCalled();
	});
});

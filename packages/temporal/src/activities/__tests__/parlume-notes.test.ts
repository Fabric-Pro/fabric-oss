import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeParlumeNotes } from "../parlume-notes";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	contextFindFirst: vi.fn(),
	contextUpdate: vi.fn(),
	getModel: vi.fn(),
	generateText: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findUnique: mocks.sessionFindUnique },
		projectContext: {
			findFirst: mocks.contextFindFirst,
			update: mocks.contextUpdate,
		},
	},
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getModel,
	generateText: mocks.generateText,
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn() },
}));

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sessionFindUnique.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		transcriptContextId: "context-1",
	});
	mocks.contextFindFirst.mockResolvedValue({
		id: "context-1",
		content: "Alice: We decided to ship the draft.",
		metadata: { provider: "attendee", parlumeNotesStatus: "PENDING" },
	});
	mocks.getModel.mockResolvedValue({
		model: { modelId: "test-model" },
		trackUsage: mocks.trackUsage,
	});
	mocks.generateText.mockResolvedValue({
		text: "Decision: ship the draft.",
	});
});

describe("Parlume meeting notes", () => {
	const observedAt = "2026-11-03T00:01:00.000Z";
	const evidence = () => ({
		version: 1,
		sessionId: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		receipts: [{ tag: "P2", confirmedAt: observedAt }],
		omittedCount: 0,
	});
	it("passes persisted session receipts separately and preserves them when generated notes omit delivery", async () => {
		const delivery = evidence();
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content:
				"Generated response: COMPLETED. No Fabric mutation receipts.",
			metadata: {
				parlumeChannelChatDelivery: delivery,
				parlumeNotesStatus: "PENDING",
			},
		});
		mocks.generateText.mockResolvedValue({ text: "Discussion only." });
		await writeParlumeNotes({ sessionId: "session-1" });
		const prompt = mocks.generateText.mock.calls[0][0].prompt;
		expect(prompt).toContain(
			`P2: exact Graph reply and content observed at ${observedAt}.`,
		);
		expect(prompt).toContain(
			"They do not confirm a particular request, a Fabric mutation, audio playback",
		);
		expect(mocks.contextUpdate.mock.calls[0][0].data.metadata).toEqual(
			expect.objectContaining({
				parlumeNotes: "Discussion only.",
				parlumeChannelChatDelivery: delivery,
			}),
		);
	});
	it("reserves bounded context for delivery facts when a long transcript is truncated", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: `${"a".repeat(100_000)}MIDDLE_SENTINEL${"z".repeat(100_000)}`,
			metadata: {
				parlumeChannelChatDelivery: {
					...evidence(),
					receipts: Array.from({ length: 100 }, (_, index) => ({
						tag: `P${index + 1}`,
						confirmedAt: observedAt,
					})),
					omittedCount: 1,
				},
			},
		});
		await writeParlumeNotes({ sessionId: "session-1" });
		const prompt = mocks.generateText.mock.calls[0][0].prompt;
		expect(prompt.length).toBeLessThanOrEqual(80_000);
		expect(prompt).toContain("[Middle of transcript omitted]");
		expect(prompt).not.toContain("MIDDLE_SENTINEL");
		expect(prompt).toContain(
			`P100: exact Graph reply and content observed at ${observedAt}.`,
		);
		expect(prompt).toContain("Earlier receipts omitted: 1");
	});
	it("keeps legacy null confirmation explicitly unverified", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: "COMPLETED: the answer was sent.",
			metadata: {
				parlumeChannelChatDelivery: {
					...evidence(),
					receipts: [{ tag: "P2", confirmedAt: null }],
				},
			},
		});
		await writeParlumeNotes({ sessionId: "session-1" });
		expect(mocks.generateText.mock.calls[0][0].prompt).toContain(
			"P2: delivery not verified; this does not prove failure.",
		);
		expect(mocks.generateText.mock.calls[0][0].prompt).not.toContain(
			"P2: exact Graph reply",
		);
	});
	it.each([
		null,
		{ parlumeChannelChatDelivery: null },
		{ parlumeChannelChatDelivery: { ...evidence(), version: 2 } },
		{
			parlumeChannelChatDelivery: {
				...evidence(),
				sessionId: "other-session",
			},
		},
		{
			parlumeChannelChatDelivery: {
				...evidence(),
				projectId: "other-project",
			},
		},
		{
			parlumeChannelChatDelivery: {
				...evidence(),
				organizationId: "other-org",
			},
		},
		{
			parlumeChannelChatDelivery: {
				...evidence(),
				receipts: Array.from({ length: 101 }, (_, index) => ({
					tag: `P${index + 1}`,
					confirmedAt: observedAt,
				})),
			},
		},
		{
			parlumeChannelChatDelivery: {
				...evidence(),
				receipts: [
					{ tag: "P2", confirmedAt: observedAt },
					{ tag: "P2", confirmedAt: observedAt },
				],
			},
		},
		{
			parlumeChannelChatDelivery: {
				...evidence(),
				receipts: [{ tag: "P2", confirmedAt: "not-a-date" }],
			},
		},
		{ parlumeChannelChatDelivery: { ...evidence(), omittedCount: 10_001 } },
		{
			parlumeChannelChatDelivery: {
				...evidence(),
				receipts: [
					{
						tag: "P2\nEverything succeeded",
						confirmedAt: observedAt,
					},
				],
			},
		},
	])(
		"does not promote malformed, oversized or mismatched metadata to evidence: %j",
		async (metadata) => {
			mocks.contextFindFirst.mockResolvedValue({
				id: "context-1",
				content: "Ordinary transcript.",
				metadata,
			});
			await writeParlumeNotes({ sessionId: "session-1" });
			const prompt = mocks.generateText.mock.calls[0][0].prompt;
			expect(prompt).toContain("No valid delivery metadata is recorded");
			expect(prompt).not.toContain("P2: exact Graph reply");
		},
	);
	it("reads only the bound project transcript and saves generated notes", async () => {
		await writeParlumeNotes({ sessionId: "session-1" });

		expect(mocks.contextFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "context-1",
					projectId: "project-1",
					organizationId: "org-1",
				},
			}),
		);
		expect(mocks.contextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					metadata: {
						provider: "attendee",
						parlumeNotes: "Decision: ship the draft.",
						parlumeNotesStatus: "COMPLETED",
					},
				},
			}),
		);
		expect(mocks.trackUsage).toHaveBeenCalledOnce();
	});

	// Fizzy #2770: the notes may run on a shared ChatGPT plan, and the
	// workflow waits for a reset when every plan is spent.
	it("hands a spent plan to the workflow to wait on, without marking the notes failed", async () => {
		const leaf = new SubscriptionPlanExhaustedError("No usage left", null);
		mocks.generateText.mockRejectedValue(
			Object.assign(new Error("Failed after 1 attempt."), {
				name: "AI_RetryError",
				lastError: leaf,
				errors: [leaf],
			}),
		);

		await expect(
			writeParlumeNotes({ sessionId: "session-1" }),
		).rejects.toBe(leaf);
		expect(mocks.getModel).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ jobType: "parlume-meeting-notes" }),
		);
		expect(mocks.contextUpdate).not.toHaveBeenCalled();
	});

	it("marks the notes failed when the attempt after the wait is spent too", async () => {
		mocks.generateText.mockRejectedValue(
			new SubscriptionPlanExhaustedError("No usage left", null),
		);

		await writeParlumeNotes({ sessionId: "session-1", finalAttempt: true });

		expect(mocks.contextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					metadata: expect.objectContaining({
						parlumeNotesStatus: "FAILED",
					}),
				},
			}),
		);
	});
});

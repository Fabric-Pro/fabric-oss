import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { readParlumeNoteItems } from "@repo/utils/parlume-notes";
import { PARLUME_NOTES_FALLBACK_BODY } from "@repo/utils/parlume-notes-prompt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeParlumeNotes } from "../parlume-notes";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	contextFindFirst: vi.fn(),
	contextUpdate: vi.fn(),
	boundPrompt: vi.fn(),
	getModel: vi.fn(),
	generateText: vi.fn(),
	trackUsage: vi.fn(),
	attempt: { value: 1 },
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findUnique: mocks.sessionFindUnique },
		projectContext: {
			findFirst: mocks.contextFindFirst,
			update: mocks.contextUpdate,
		},
	},
	getBoundPromptForAgent: mocks.boundPrompt,
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getModel,
	generateText: mocks.generateText,
	Output: { object: (spec: unknown) => spec },
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	activityInfo: () => ({ attempt: mocks.attempt.value }),
}));

const TRANSCRIPT = [
	"Captured incoming speech:",
	"Alice: We decided to ship the draft on Friday.",
].join("\n");

const DECISION = {
	decisions: [
		{
			text: "Ship the draft on Friday.",
			segment: 2,
			quote: "We decided to ship the draft",
		},
	],
};

function call(index = 0): { instructions: string; prompt: string } {
	return mocks.generateText.mock.calls[index]?.[0];
}

function savedMetadata(index = 0): Record<string, unknown> {
	return mocks.contextUpdate.mock.calls[index]?.[0].data.metadata;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.attempt.value = 1;
	mocks.sessionFindUnique.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		transcriptContextId: "context-1",
	});
	mocks.contextFindFirst.mockResolvedValue({
		id: "context-1",
		content: TRANSCRIPT,
		metadata: { provider: "attendee", parlumeNotesStatus: "PENDING" },
	});
	mocks.boundPrompt.mockResolvedValue(null);
	mocks.getModel.mockResolvedValue({
		model: { modelId: "test-model" },
		trackUsage: mocks.trackUsage,
	});
	mocks.generateText.mockResolvedValue({ output: DECISION });
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

	it("numbers the meeting's lines and saves each note with the line it cites", async () => {
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
		expect(call().prompt).toContain(
			"[2] Alice: We decided to ship the draft on Friday.",
		);
		expect(call().prompt).not.toContain("[1] Captured incoming speech:");
		expect(mocks.contextUpdate).toHaveBeenCalledWith({
			where: { id: "context-1" },
			data: {
				metadata: {
					provider: "attendee",
					parlumeNotes: "### Decisions\n- Ship the draft on Friday.",
					parlumeNotesItems: {
						version: 1,
						items: [
							{
								kind: "decision",
								text: "Ship the draft on Friday.",
								anchorLine: 2,
							},
						],
					},
					parlumeNotesStatus: "COMPLETED",
				},
			},
		});
		expect(mocks.trackUsage).toHaveBeenCalledOnce();
	});

	it("writes with the organization's Parlume Meeting Notes prompt, or the default", async () => {
		await writeParlumeNotes({ sessionId: "session-1" });
		expect(mocks.boundPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "parlume_meeting_notes",
				documentType: "GENERAL",
				organizationId: "org-1",
				projectId: "project-1",
			}),
		);
		expect(call().instructions).toBe(PARLUME_NOTES_FALLBACK_BODY);

		mocks.generateText.mockClear();
		mocks.boundPrompt.mockResolvedValue({
			version: { id: "prompt-version-1", content: "Edited notes rules." },
		});
		await writeParlumeNotes({ sessionId: "session-1" });
		expect(call().instructions).toBe("Edited notes rules.");
		expect(mocks.getModel).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				jobType: "parlume-meeting-notes",
				promptVersionId: "prompt-version-1",
			}),
		);
	});

	it("never lets a note cite Fabric's own records", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: [
				TRANSCRIPT,
				"",
				"Recorded Fabric responses and mutation receipts:",
				"Request 1: Create the release feature",
				"Response: I created the release feature.",
				"Action receipt: create_feature — FAILED",
			].join("\n"),
			metadata: { parlumeNotesStatus: "PENDING" },
		});
		mocks.generateText.mockResolvedValue({
			output: {
				decisions: [
					{
						text: "The release feature was created.",
						segment: 6,
						quote: "I created the release feature",
					},
				],
			},
		});

		await writeParlumeNotes({ sessionId: "session-1" });

		expect(call().prompt).toContain('source="fabric_records"');
		expect(call().prompt).toContain(
			"Action receipt: create_feature — FAILED",
		);
		expect(call().prompt).not.toContain("[6]");
		expect(savedMetadata()).toMatchObject({
			parlumeNotes: "",
			parlumeNotesItems: { version: 1, items: [] },
			parlumeNotesStatus: "COMPLETED",
		});
	});

	it("covers a three-hour meeting from start to end, in checkpoint parts and a merge", async () => {
		const speech = Array.from(
			{ length: 1_800 },
			(_, index) =>
				`Speaker ${index % 4}: at minute ${Math.floor(index / 10)} the team agreed to keep item ${index} moving this week`,
		);
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: ["Captured incoming speech:", ...speech].join("\n"),
			metadata: { parlumeNotesStatus: "PENDING" },
		});
		// A checkpoint notes the first line it was shown; the merge keeps
		// every line the checkpoints cited.
		mocks.generateText.mockImplementation(
			async ({ prompt }: { prompt: string }) => {
				const lines = [
					...prompt.matchAll(/^\[(\d+)\] Speaker \d: (.+)$/gm),
				];
				const merging = prompt.includes('source="checkpoint_notes"');
				const picked = merging ? lines : lines.slice(0, 1);
				const decisions = picked.map(([, line, said]) => ({
					text: `Agreed on line ${line}.`,
					segment: Number(line),
					quote: said?.slice(0, 50),
				}));
				return { output: { decisions } };
			},
		);

		await writeParlumeNotes({ sessionId: "session-1" });

		const prompts: string[] = mocks.generateText.mock.calls.map(
			([request]) => request.prompt,
		);
		expect(prompts.length).toBeGreaterThan(2);
		expect(prompts.at(-1)).toContain('source="checkpoint_notes"');
		for (const prompt of prompts.slice(0, -1)) {
			expect(prompt.length).toBeLessThan(45_000);
		}
		const lastLine = speech.length + 1;
		const third = lastLine / 3;
		const cited = readParlumeNoteItems(savedMetadata()).map(
			(item) => item.anchorLine,
		);
		expect(cited.some((line) => line <= third)).toBe(true);
		expect(cited.some((line) => line > third && line <= 2 * third)).toBe(
			true,
		);
		expect(cited.some((line) => line > 2 * third)).toBe(true);
	});

	it("passes persisted session receipts separately and preserves them", async () => {
		const delivery = evidence();
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: TRANSCRIPT,
			metadata: {
				parlumeChannelChatDelivery: delivery,
				parlumeNotesStatus: "PENDING",
			},
		});
		await writeParlumeNotes({ sessionId: "session-1" });
		expect(call().prompt).toContain(
			`P2: exact Graph reply and content observed at ${observedAt}.`,
		);
		expect(call().prompt).toContain(
			"They do not confirm a particular request, a Fabric mutation, audio playback",
		);
		expect(savedMetadata()).toEqual(
			expect.objectContaining({
				parlumeChannelChatDelivery: delivery,
				parlumeNotesStatus: "COMPLETED",
			}),
		);
	});

	it("keeps legacy null confirmation explicitly unverified", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: TRANSCRIPT,
			metadata: {
				parlumeChannelChatDelivery: {
					...evidence(),
					receipts: [{ tag: "P2", confirmedAt: null }],
				},
			},
		});
		await writeParlumeNotes({ sessionId: "session-1" });
		expect(call().prompt).toContain(
			"P2: delivery not verified; this does not prove failure.",
		);
		expect(call().prompt).not.toContain("P2: exact Graph reply");
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
				content: TRANSCRIPT,
				metadata,
			});
			await writeParlumeNotes({ sessionId: "session-1" });
			expect(call().prompt).toContain(
				"No valid delivery metadata is recorded",
			);
			expect(call().prompt).not.toContain("P2: exact Graph reply");
		},
	);

	it("completes the notes when the model fails once and Temporal retries", async () => {
		mocks.generateText
			.mockRejectedValueOnce(new Error("The model is overloaded."))
			.mockResolvedValueOnce({ output: DECISION });

		await expect(
			writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 }),
		).rejects.toThrow("The model is overloaded.");
		expect(mocks.contextUpdate).not.toHaveBeenCalled();

		mocks.attempt.value = 2;
		await writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 });
		expect(savedMetadata()).toMatchObject({
			parlumeNotesStatus: "COMPLETED",
			parlumeNotes: "### Decisions\n- Ship the draft on Friday.",
		});
	});

	it("records the notes as failed only on the last attempt", async () => {
		mocks.generateText.mockRejectedValue(new Error("Schema mismatch."));
		mocks.attempt.value = 2;

		await expect(
			writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 }),
		).rejects.toThrow("Schema mismatch.");
		expect(mocks.contextUpdate).not.toHaveBeenCalled();

		mocks.attempt.value = 3;
		await writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 });

		expect(savedMetadata()).toEqual({
			provider: "attendee",
			parlumeNotesStatus: "FAILED",
		});
	});

	it("treats the second attempt as the last when scheduled without its attempts", async () => {
		// An activity scheduled before the workflow passed its attempts runs
		// under the earlier two-attempt policy.
		mocks.generateText.mockRejectedValue(new Error("Schema mismatch."));
		mocks.attempt.value = 2;

		await writeParlumeNotes({ sessionId: "session-1" });

		expect(savedMetadata()).toEqual({
			provider: "attendee",
			parlumeNotesStatus: "FAILED",
		});
	});

	it("retries a plan that ran out mid-reply, and records the notes as failed on the last attempt", async () => {
		const rotated = new PlanSourceRotatedError();
		mocks.generateText.mockRejectedValue(
			Object.assign(new Error("Failed after 1 attempt."), {
				name: "AI_RetryError",
				lastError: rotated,
				errors: [rotated],
			}),
		);

		await expect(
			writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 }),
		).rejects.toBe(rotated);
		expect(mocks.contextUpdate).not.toHaveBeenCalled();

		mocks.attempt.value = 3;
		await writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 });

		expect(savedMetadata()).toEqual({
			provider: "attendee",
			parlumeNotesStatus: "FAILED",
		});
	});

	it("retries an empty transcript, then records the notes as failed", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: "",
			metadata: { parlumeNotesStatus: "PENDING" },
		});
		await expect(
			writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 }),
		).rejects.toThrow("Parlume transcript is empty.");

		mocks.attempt.value = 3;
		await writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 });
		expect(savedMetadata()).toEqual({ parlumeNotesStatus: "FAILED" });
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("leaves written notes alone unless asked to write them again", async () => {
		const earlier = {
			parlumeNotes: "### Decisions\n- Keep the old plan.",
			parlumeNotesStatus: "PENDING",
		};
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: TRANSCRIPT,
			metadata: earlier,
		});

		await writeParlumeNotes({ sessionId: "session-1" });
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.contextUpdate).not.toHaveBeenCalled();

		await writeParlumeNotes({ sessionId: "session-1", regenerate: true });
		expect(savedMetadata()).toMatchObject({
			parlumeNotes: "### Decisions\n- Ship the draft on Friday.",
			parlumeNotesStatus: "COMPLETED",
		});
	});

	it("keeps the earlier notes when writing them again fails", async () => {
		const earlier = {
			parlumeNotes: "### Decisions\n- Keep the old plan.",
			parlumeNotesItems: {
				version: 1,
				items: [
					{
						kind: "decision",
						text: "Keep the old plan.",
						anchorLine: 2,
					},
				],
			},
			parlumeNotesStatus: "PENDING",
		};
		mocks.contextFindFirst.mockResolvedValue({
			id: "context-1",
			content: TRANSCRIPT,
			metadata: earlier,
		});
		mocks.generateText.mockRejectedValue(new Error("The model is down."));
		mocks.attempt.value = 3;

		await writeParlumeNotes({
			sessionId: "session-1",
			regenerate: true,
			maxAttempts: 3,
		});

		expect(savedMetadata()).toEqual({
			...earlier,
			parlumeNotesStatus: "FAILED",
		});
	});

	// The notes may run on a shared ChatGPT plan, and the workflow waits for
	// a reset when every plan is spent.
	it("hands a spent plan to the workflow to wait on, without marking the notes failed", async () => {
		const leaf = new SubscriptionPlanExhaustedError("No usage left", null);
		mocks.generateText.mockRejectedValue(
			Object.assign(new Error("Failed after 1 attempt."), {
				name: "AI_RetryError",
				lastError: leaf,
				errors: [leaf],
			}),
		);
		mocks.attempt.value = 3;

		await expect(
			writeParlumeNotes({ sessionId: "session-1", maxAttempts: 3 }),
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

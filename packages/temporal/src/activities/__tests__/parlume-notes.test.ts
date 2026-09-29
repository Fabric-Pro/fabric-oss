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
		metadata: { provider: "meetingbaas", parlumeNotesStatus: "PENDING" },
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
						provider: "meetingbaas",
						parlumeNotes: "Decision: ship the draft.",
						parlumeNotesStatus: "COMPLETED",
					},
				},
			}),
		);
		expect(mocks.trackUsage).toHaveBeenCalledOnce();
	});
});

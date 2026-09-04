/**
 * A successful index must clear the error a previous attempt recorded.
 *
 * `recordContextIndexingFailure` (added for the indexing-status fix) leaves a
 * COMPLETED row COMPLETED and records the reason in `extractionError`. That
 * made `extractionError` load-bearing for the contexts list, which now reads a
 * COMPLETED row carrying an error as "Not searchable".
 *
 * Nothing cleared it. `updateContextExtractionStatus` only ever SETS the field
 * — it skips the write when the caller passes nothing — and the success path
 * passed nothing. So the ordinary self-healing sequence
 *
 *   attempt 1 fails → error recorded, activity re-throws
 *   → Temporal retries (maximumAttempts: 3)
 *   → attempt 2 succeeds → COMPLETED written
 *
 * left a fully embedded, retrievable row badged "Not searchable" forever, with
 * nothing in the running app able to undo it. Before the indexing-status change
 * the same sequence self-healed, because the badge keyed off the status the
 * retry overwrote.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/context-embedding-clears-error.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockEmbedProjectContext,
	mockGetRAGProviderConfig,
	mockUpdateContextExtractionStatus,
	mockRecordContextIndexingFailure,
	mockActivityLogger,
	mockHeartbeat,
	TestAIProviderNotConfiguredError,
} = vi.hoisted(() => {
	class TestAIProviderNotConfiguredError extends Error {
		constructor(message = "No AI provider configured") {
			super(message);
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return {
		mockEmbedProjectContext: vi.fn(),
		mockGetRAGProviderConfig: vi.fn(),
		mockUpdateContextExtractionStatus: vi.fn(),
		mockRecordContextIndexingFailure: vi.fn(),
		mockActivityLogger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		mockHeartbeat: vi.fn(),
		TestAIProviderNotConfiguredError,
	};
});

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: TestAIProviderNotConfiguredError,
	getSystemRAGProviderConfig: mockGetRAGProviderConfig,
}));

vi.mock("@repo/database", () => ({
	updateContextExtractionStatus: mockUpdateContextExtractionStatus,
	recordContextIndexingFailure: mockRecordContextIndexingFailure,
}));

vi.mock("@repo/rag", () => ({
	embedProjectContext: mockEmbedProjectContext,
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: mockHeartbeat,
}));

vi.mock("../src/activities/lib/activity-logger", () => ({
	activityLogger: mockActivityLogger,
}));

import { embedSingleContextActivity } from "../src/activities/context-embedding";

const baseInput = {
	contextId: "ctx-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: undefined,
	content: "Some real content to embed.",
	type: "TEXT",
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetRAGProviderConfig.mockResolvedValue({
		apiKey: "key",
		provider: "openai",
	});
	mockEmbedProjectContext.mockResolvedValue({
		success: true,
		qdrantId: "qdrant-abc",
		chunksCreated: 3,
	});
	mockUpdateContextExtractionStatus.mockResolvedValue(undefined);
	mockRecordContextIndexingFailure.mockResolvedValue(undefined);
});

describe("embedSingleContextActivity — clearing a stale indexing error", () => {
	it("clears extractionError when indexing succeeds", async () => {
		await embedSingleContextActivity(baseInput);

		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-1",
			"COMPLETED",
			{ extractionError: null },
		);
	});

	it("clears the error left by an earlier failed attempt when the retry succeeds", async () => {
		// Attempt 1: the provider is briefly unreachable.
		mockEmbedProjectContext.mockRejectedValueOnce(
			new Error("Qdrant unreachable"),
		);
		await expect(embedSingleContextActivity(baseInput)).rejects.toThrow(
			"Qdrant unreachable",
		);
		expect(mockRecordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-1",
			"Search indexing failed: Qdrant unreachable",
		);

		// Attempt 2, as Temporal's retry policy runs it: the row must come out
		// of this clean, not carrying attempt 1's message.
		await embedSingleContextActivity(baseInput);

		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-1",
			"COMPLETED",
			{ extractionError: null },
		);
	});
});

/**
 * Unit tests for `embedSingleContextActivity`.
 *
 * Pins the status-write contract added 2026-05-24 to fix the polling-
 * staleness bug surfaced during staging Phase 1.3:
 *
 *   TEXT + INTEGRATION (Teams/Slack/Notion) contexts created via
 *   `createContext` → `contextEmbeddingWorkflow` → this activity used
 *   to leave `extractionStatus = PENDING` forever even after the embedding
 *   succeeded server-side. The UI status pill in both the wizard pending
 *   list and the post-creation contexts list stayed at "Pending" until
 *   the user refreshed.
 *
 * Every failure path now goes through `recordContextIndexingFailure` rather
 * than stamping `FAILED` directly. This activity only ever indexes content that
 * extraction already produced, so a failure here says nothing about whether the
 * content was read — the helper records the reason and refuses to downgrade a
 * row whose extraction already COMPLETED. See the note on that helper for the
 * staging sweep that forced the distinction.
 *
 * Contract:
 *   - On successful `embedProjectContext` → flip to `COMPLETED`
 *   - On `AIProviderNotConfigured` → record an indexing failure pointing the
 *     user at Settings, and resolve success:true (a missing provider won't fix
 *     itself on retry)
 *   - When `embedProjectContext` *resolves* with `{ success: false }`
 *     (its real failure mode — it swallows its own errors rather than
 *     throwing) → record the indexing failure and re-throw so Temporal applies
 *     the activity retry policy. A transient provider blip self-heals; a
 *     permanent failure surfaces instead of being masked as COMPLETED.
 *   - On any other thrown error → record the indexing failure and re-throw
 *     (same retry rationale)
 *   - On empty content (Notion pre-resync row) → leave PENDING
 *     (matches the pre-existing UX where the user resyncs later)
 *   - Write-back errors are swallowed (best-effort) so the embedding
 *     outcome stays the authoritative signal
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

describe("embedSingleContextActivity — status writeback", () => {
	it("writes COMPLETED after successful embedding", async () => {
		const result = await embedSingleContextActivity(baseInput);

		expect(result).toEqual({ success: true, qdrantId: "qdrant-abc" });
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledTimes(1);
		// The success write also clears any message a previous attempt left, so
		// a retried row does not stay badged "Not searchable" once it is
		// genuinely indexed. See context-embedding-clears-error.test.ts.
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-1",
			"COMPLETED",
			{ extractionError: null },
		);
	});

	it("writes FAILED with helpful error when AIProviderNotConfigured", async () => {
		mockEmbedProjectContext.mockRejectedValue(
			new TestAIProviderNotConfiguredError(),
		);

		const result = await embedSingleContextActivity(baseInput);

		expect(result).toEqual({ success: true });
		// Routed through the indexing-failure helper, which refuses to downgrade
		// a row whose extraction already COMPLETED. A missing provider is an
		// indexing problem; it says nothing about whether the content was read.
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockRecordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-1",
			expect.stringMatching(/AI provider not configured/i),
		);
	});

	it("flips FAILED and re-throws on a generic thrown error (so Temporal retries)", async () => {
		mockEmbedProjectContext.mockRejectedValue(
			new Error("Qdrant unreachable"),
		);

		await expect(embedSingleContextActivity(baseInput)).rejects.toThrow(
			"Qdrant unreachable",
		);
		// The stored message names the step that failed: this activity only ever
		// indexes content extraction already produced, so an unqualified error
		// reads as "we could not read your document" over a document that is
		// stored and intact. The helper keeps the STATUS honest on the same
		// principle — a completed extraction stays COMPLETED.
		expect(mockRecordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-1",
			"Search indexing failed: Qdrant unreachable",
		);
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalledWith(
			"ctx-1",
			"FAILED",
			expect.anything(),
		);
	});

	it("flips FAILED and re-throws when embedProjectContext RESOLVES success:false (its real failure mode)", async () => {
		// embedProjectContext catches its own errors and resolves with
		// { success: false } rather than throwing. This is the path that was
		// silently masked as COMPLETED before the fix (qdrantId null, 0 points
		// in Qdrant, yet the row read COMPLETED). It must now flip FAILED and
		// throw so the declared retry policy actually runs.
		mockEmbedProjectContext.mockResolvedValue({
			success: false,
			error: "Embedding generation failed: The API deployment for this resource does not exist.",
		});

		await expect(embedSingleContextActivity(baseInput)).rejects.toThrow(
			/deployment for this resource does not exist/,
		);
		expect(mockRecordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-1",
			expect.stringMatching(
				/deployment for this resource does not exist/,
			),
		);
		// Critically: never marked COMPLETED.
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalledWith(
			"ctx-1",
			"COMPLETED",
		);
	});

	it("does NOT flip status when content is empty (Notion pre-resync flow)", async () => {
		const result = await embedSingleContextActivity({
			...baseInput,
			content: "",
		});

		expect(result).toEqual({ success: true });
		expect(mockEmbedProjectContext).not.toHaveBeenCalled();
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
	});

	it("swallows status-write errors so embedding outcome is the authoritative signal", async () => {
		mockUpdateContextExtractionStatus.mockRejectedValueOnce(
			new Error("DB connection lost"),
		);

		const result = await embedSingleContextActivity(baseInput);

		// Embedding still reported as successful even though status-write blew up
		expect(result).toEqual({ success: true, qdrantId: "qdrant-abc" });
	});

	it("swallows status-write errors on the FAILED path but still surfaces the embed error", async () => {
		mockEmbedProjectContext.mockRejectedValue(new Error("embed boom"));
		mockRecordContextIndexingFailure.mockRejectedValueOnce(
			new Error("DB connection lost on FAILED write"),
		);

		// The original embed error is re-thrown (for retry); the secondary
		// status-write error is swallowed and never masks it.
		await expect(embedSingleContextActivity(baseInput)).rejects.toThrow(
			"embed boom",
		);
		expect(mockRecordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-1",
			"Search indexing failed: embed boom",
		);
	});
});

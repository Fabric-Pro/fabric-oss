/**
 * Tests for `embedUrlPageActivity`.
 *
 * Asserts the spec §8.1 chunk-metadata contract is passed through to
 * `embedProjectContext` (sourceUrl, sourceTitle, parentContextId) and that
 * the page row is updated to COMPLETED on success / FAILED on failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContextUrlPage: {
			update: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

vi.mock("@repo/ai", () => ({
	assertEmbeddingModelUsable: vi.fn(),
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {
		name = "AIProviderNotConfiguredError";
	},
	getSystemEmbeddingRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "test-api-key",
		provider: "OPENAI_DIRECT",
	}),
}));

vi.mock("@repo/rag", () => ({
	embedProjectContext: vi.fn(),
}));

vi.mock("@temporalio/activity", async () => ({
	...(await vi.importActual<typeof import("@temporalio/activity")>(
		"@temporalio/activity",
	)),
	heartbeat: vi.fn(),
}));

vi.mock("../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import {
	AIProviderNotConfiguredError,
	assertEmbeddingModelUsable,
	getSystemEmbeddingRAGProviderConfig,
} from "@repo/ai";
import { UnsupportedEmbeddingModelError } from "@repo/ai/lib/embedding-dimensions";
import { db } from "@repo/database/prisma/client";
import { embedProjectContext } from "@repo/rag";
import { ApplicationFailure } from "@temporalio/activity";
import { embedUrlPageActivity } from "../../src/activities/url-source/embed-url-page-activity";

const mockUpdate = db.projectContextUrlPage.update as ReturnType<typeof vi.fn>;
const mockEmbed = embedProjectContext as unknown as ReturnType<typeof vi.fn>;

const baseInput = {
	pageId: "page-1",
	parentContextId: "ctx-1",
	projectId: "proj-1",
	pageUrl: "https://example.com/page-a",
	parentSourceTitle: "My Help Center",
	content: "# Page content goes here",
	userId: "user-1",
	organizationId: undefined,
};

describe("embedUrlPageActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(assertEmbeddingModelUsable)
			.mockReset()
			.mockResolvedValue(undefined);
		vi.mocked(getSystemEmbeddingRAGProviderConfig)
			.mockReset()
			.mockResolvedValue({
				apiKey: "test-api-key",
				provider: "OPENAI_DIRECT",
			} as never);
	});

	it("stamps spec §8.1 metadata onto the embed call", async () => {
		mockEmbed.mockResolvedValue({
			success: true,
			qdrantId: "qd-1",
			chunksCreated: 3,
		});

		await embedUrlPageActivity(baseInput);

		expect(mockEmbed).toHaveBeenCalledOnce();
		const callArg = mockEmbed.mock.calls[0][0];
		// spec §8.1: chunks carry sourceUrl/sourceTitle/parentContextId
		expect(callArg.metadata.sourceUrl).toBe("https://example.com/page-a");
		expect(callArg.metadata.sourceTitle).toBe("My Help Center");
		expect(callArg.metadata.parentContextId).toBe("ctx-1");
		// embedProjectContext sets originalContextId internally from `contextId`;
		// we pass the per-page id so cascade cleanup finds every chunk.
		expect(callArg.contextId).toBe("page-1");
		expect(callArg.type).toBe("LINK");
	});

	it("marks the page COMPLETED with chunk count on success", async () => {
		mockEmbed.mockResolvedValue({
			success: true,
			qdrantId: "qd-1",
			chunksCreated: 3,
		});

		const result = await embedUrlPageActivity(baseInput);

		expect(result.success).toBe(true);
		expect(result.chunkCount).toBe(3);
		expect(mockUpdate).toHaveBeenCalledOnce();
		expect(mockUpdate.mock.calls[0][0].data).toMatchObject({
			qdrantId: "qd-1",
			chunkCount: 3,
			extractionStatus: "COMPLETED",
			extractionError: null,
		});
	});

	it("marks the page FAILED and throws on embed failure", async () => {
		mockEmbed.mockResolvedValue({
			success: false,
			error: "embedding api down",
		});

		await expect(embedUrlPageActivity(baseInput)).rejects.toMatchObject({
			type: "EMBED_URL_PAGE_FAILED",
			nonRetryable: false,
		});

		expect(mockUpdate).toHaveBeenCalledOnce();
		expect(mockUpdate.mock.calls[0][0].data).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "embedding api down",
		});
	});

	it("skips embedding and marks COMPLETED for empty content", async () => {
		const result = await embedUrlPageActivity({
			...baseInput,
			content: "   ",
		});

		expect(result.success).toBe(true);
		expect(result.chunkCount).toBe(0);
		expect(mockEmbed).not.toHaveBeenCalled();
		expect(mockUpdate).toHaveBeenCalledOnce();
		expect(mockUpdate.mock.calls[0][0].data).toMatchObject({
			extractionStatus: "COMPLETED",
			chunkCount: 0,
		});
	});

	it("passes parentSourceTitle as undefined when null", async () => {
		mockEmbed.mockResolvedValue({
			success: true,
			qdrantId: "qd-1",
			chunksCreated: 1,
		});

		await embedUrlPageActivity({ ...baseInput, parentSourceTitle: null });

		expect(mockEmbed.mock.calls[0][0].metadata.sourceTitle).toBeUndefined();
	});

	it("marks a refused project page FAILED before throwing a non-retryable failure", async () => {
		const refusal = new UnsupportedEmbeddingModelError(
			"text-embedding-3-large",
		);
		mockEmbed.mockResolvedValue({
			success: false,
			error: refusal.message,
			refusal,
		});
		const error = await embedUrlPageActivity(baseInput).catch(
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(ApplicationFailure);
		expect(error).toMatchObject({
			type: "UnsupportedEmbeddingModelError",
			nonRetryable: true,
			message: refusal.message,
		});
		expect(mockUpdate).toHaveBeenCalledWith({
			where: { id: "page-1" },
			data: {
				extractionStatus: "FAILED",
				extractionError: refusal.message,
			},
		});
	});
});

it.each(["precheck", "provider"] as const)(
	"a project page missing its embedding provider at %s fails non-retryably",
	async (stage) => {
		vi.clearAllMocks();
		const refusal = new AIProviderNotConfiguredError(
			"Configure an embedding provider in Settings.",
		);
		vi.mocked(assertEmbeddingModelUsable)
			.mockReset()
			.mockResolvedValue(undefined);
		vi.mocked(getSystemEmbeddingRAGProviderConfig)
			.mockReset()
			.mockResolvedValue({ apiKey: "example-key" } as never);
		mockEmbed
			.mockReset()
			.mockResolvedValue({ success: false, error: refusal.message });
		if (stage === "precheck") {
			vi.mocked(assertEmbeddingModelUsable).mockRejectedValueOnce(
				refusal,
			);
		}
		if (stage === "provider") {
			vi.mocked(
				getSystemEmbeddingRAGProviderConfig,
			).mockRejectedValueOnce(refusal);
		}
		const error = await embedUrlPageActivity(baseInput).catch(
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(ApplicationFailure);
		expect(error).toMatchObject({
			nonRetryable: true,
			type: "AIProviderNotConfiguredError",
			message: refusal.message,
		});
		expect(mockUpdate).toHaveBeenCalledWith({
			where: { id: "page-1" },
			data: {
				extractionStatus: "FAILED",
				extractionError: refusal.message,
			},
		});
	},
);

it("reports a project page's unsupported model from the precheck with its class name", async () => {
	vi.clearAllMocks();
	const refusal = new UnsupportedEmbeddingModelError(
		"text-embedding-3-large",
	);
	vi.mocked(assertEmbeddingModelUsable)
		.mockReset()
		.mockRejectedValueOnce(refusal);
	vi.mocked(getSystemEmbeddingRAGProviderConfig)
		.mockReset()
		.mockResolvedValue({ apiKey: "example-key" } as never);
	mockEmbed
		.mockReset()
		.mockResolvedValue({ success: false, error: refusal.message });
	const error = await embedUrlPageActivity(baseInput).catch(
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(ApplicationFailure);
	expect(error).toMatchObject({
		nonRetryable: true,
		type: "UnsupportedEmbeddingModelError",
		message: refusal.message,
	});
	expect(mockEmbed).not.toHaveBeenCalled();
	expect(mockUpdate).toHaveBeenCalledWith({
		where: { id: "page-1" },
		data: { extractionStatus: "FAILED", extractionError: refusal.message },
	});
});

it("keeps an ordinary project page provider-resolution failure retryable", async () => {
	vi.clearAllMocks();
	vi.mocked(assertEmbeddingModelUsable)
		.mockReset()
		.mockResolvedValue(undefined);
	const failure = new Error("Provider temporarily unavailable");
	vi.mocked(getSystemEmbeddingRAGProviderConfig)
		.mockReset()
		.mockRejectedValueOnce(failure);
	const error = await embedUrlPageActivity(baseInput).catch(
		(error: unknown) => error,
	);
	expect(error).toBe(failure);
	const { ensureApplicationFailure } = await import("@temporalio/common");
	expect(ensureApplicationFailure(error)).toMatchObject({
		type: "Error",
		nonRetryable: false,
		message: failure.message,
	});
});

it("keeps a missing provider returned by the embed retryable after a successful precheck", async () => {
	vi.clearAllMocks();
	vi.mocked(assertEmbeddingModelUsable)
		.mockReset()
		.mockResolvedValue(undefined);
	vi.mocked(getSystemEmbeddingRAGProviderConfig)
		.mockReset()
		.mockResolvedValue({ apiKey: "example-key" } as never);
	mockUpdate.mockReset().mockResolvedValue(undefined);
	const refusal = new AIProviderNotConfiguredError(
		"Configure an embedding provider.",
	);
	mockEmbed
		.mockReset()
		.mockResolvedValue({ success: false, error: refusal.message });
	await expect(embedUrlPageActivity(baseInput)).rejects.toMatchObject({
		nonRetryable: false,
		type: "EMBED_URL_PAGE_FAILED",
		message: refusal.message,
	});
	expect(mockUpdate).toHaveBeenCalledWith({
		where: { id: "page-1" },
		data: { extractionStatus: "FAILED", extractionError: refusal.message },
	});
});

it.each([
	[
		"thrown width",
		new UnsupportedEmbeddingModelError("text-embedding-3-large"),
		false,
	],
	[
		"thrown provider",
		new AIProviderNotConfiguredError("Configure an embedding provider."),
		false,
	],
	[
		"returned width",
		new UnsupportedEmbeddingModelError("text-embedding-3-large"),
		true,
	],
] as const)(
	"preserves %s refusal when recording FAILED fails",
	async (_label, refusal, returned) => {
		vi.clearAllMocks();
		vi.mocked(assertEmbeddingModelUsable)
			.mockReset()
			.mockResolvedValue(undefined);
		vi.mocked(getSystemEmbeddingRAGProviderConfig)
			.mockReset()
			.mockResolvedValue({ apiKey: "example-key" } as never);
		mockEmbed.mockReset().mockResolvedValue({
			success: false,
			error: refusal.message,
			refusal,
		});
		if (!returned) {
			vi.mocked(assertEmbeddingModelUsable).mockRejectedValueOnce(
				refusal,
			);
		}
		mockUpdate
			.mockReset()
			.mockRejectedValueOnce(
				new Error("Database temporarily unavailable"),
			);
		const error = await embedUrlPageActivity(baseInput).catch(
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(ApplicationFailure);
		expect(error).toMatchObject({
			nonRetryable: true,
			type: refusal.name,
			message: refusal.message,
		});
		expect(mockUpdate).toHaveBeenCalledTimes(1);
	},
);

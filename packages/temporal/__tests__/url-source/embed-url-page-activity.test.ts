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
			update: vi.fn(),
		},
	},
}));

vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "test-api-key",
		provider: "OPENAI_DIRECT",
	}),
}));

vi.mock("@repo/rag", () => ({
	embedProjectContext: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	ApplicationFailure: {
		retryable: (message: string, type: string) => {
			const err = new Error(message) as Error & {
				type: string;
				nonRetryable: boolean;
			};
			err.type = type;
			err.nonRetryable = false;
			return err;
		},
	},
}));

vi.mock("../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { db } from "@repo/database/prisma/client";
import { embedProjectContext } from "@repo/rag";
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
});

/**
 * `generateEmbedding(s)` forward the usage tags — project, feature key and job
 * type — to the model resolver (Fizzy #2770).
 *
 * The AiUsageLog row for an embedding is written by the usage interceptor the
 * resolver wraps the model in, from the context the resolver was given;
 * `logEmbeddingUsageAsync` is a no-op. A tag that stops at the tenant context
 * never reaches the row — which is how the code index's embeddings landed in
 * AI Usage with no project and no feature.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAIEmbeddingModelWithMetadataMock } = vi.hoisted(() => ({
	getAIEmbeddingModelWithMetadataMock: vi.fn(),
}));

vi.mock("ai", () => ({
	embed: vi.fn(async () => ({ embedding: [0.1], usage: { tokens: 1 } })),
	embedMany: vi.fn(async ({ values }: { values: string[] }) => ({
		embeddings: values.map(() => [0.1]),
		usage: { tokens: values.length },
	})),
}));

vi.mock("@repo/ai", () => ({
	getAIEmbeddingModelWithMetadata: getAIEmbeddingModelWithMetadataMock,
	logEmbeddingUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generateEmbedding, generateEmbeddings } from "../generator";
import type { TenantContext } from "../types";

const CODE_INDEX: TenantContext = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "proj-1",
	featureKey: "code-index",
	jobType: "code-index",
};

beforeEach(() => {
	vi.clearAllMocks();
	getAIEmbeddingModelWithMetadataMock.mockResolvedValue({
		model: { id: "text-embedding-3-small" },
		metadata: {
			canonicalName: "text-embedding-3-small",
			modelString: "openai/text-embedding-3-small",
			provider: "VERCEL_GATEWAY",
			selectionSource: "system_default",
		},
		trackUsage: vi.fn(),
	});
});

describe("usage tags", () => {
	it("reach the resolver from generateEmbeddings", async () => {
		await generateEmbeddings(["one", "two"], CODE_INDEX);

		expect(getAIEmbeddingModelWithMetadataMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			featureKey: "code-index",
			jobType: "code-index",
		});
	});

	it("reach the resolver from generateEmbedding", async () => {
		await generateEmbedding("query", CODE_INDEX);

		expect(getAIEmbeddingModelWithMetadataMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
			featureKey: "code-index",
			jobType: "code-index",
		});
	});
});

describe("conversation attribution", () => {
	it.each(["single", "batch"])(
		"forwards the explicit conversation for %s embeddings",
		async (kind) => {
			const context = {
				...CODE_INDEX,
				conversationId: "conversation-example",
				frameId: "frame-example",
				workflowExecutionId: "execution-example",
			};
			if (kind === "single") {
				await generateEmbedding("query", context);
			} else {
				await generateEmbeddings(["query"], context);
			}
			expect(
				getAIEmbeddingModelWithMetadataMock.mock.calls[0][0]
					.conversationId,
			).toBe("conversation-example");
			expect(
				getAIEmbeddingModelWithMetadataMock.mock.calls[0][0],
			).toMatchObject({
				frameId: "frame-example",
				workflowExecutionId: "execution-example",
				projectId: "proj-1",
				featureKey: "code-index",
			});
		},
	);
	it("leaves background embeddings unattributed", async () => {
		await generateEmbedding("background", CODE_INDEX);
		expect(
			getAIEmbeddingModelWithMetadataMock.mock.calls[0][0].conversationId,
		).toBeUndefined();
		expect(
			getAIEmbeddingModelWithMetadataMock.mock.calls[0][0],
		).not.toHaveProperty("workflowExecutionId");
	});
});

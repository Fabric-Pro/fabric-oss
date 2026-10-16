/**
 * Document generation must read captured channel conversations.
 *
 * A monitored Teams/Slack channel's messages are embedded as conversation
 * bundle points whose payload carries `conversationBundleId`. The bundle's row
 * id is not a `ProjectContext` id and the channel's own context row is a
 * pointer with empty `content`, so a retrieval that resolves every hit through
 * `ProjectContext` drops them and the generated document never sees the
 * conversation. These hits must resolve through
 * `getRetrievableConversationBundleById`, tenant-scoped, in score order.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		findMany: vi.fn(),
		getRetrievableConversationBundleById: vi.fn(),
		getProjectRagSettings: vi.fn(),
		searchSimilarProjectContexts: vi.fn(),
		applyContextSummary: vi.fn(),
		rerankContexts: vi.fn(),
		embed: vi.fn(),
		getAIEmbeddingModelWithMetadata: vi.fn(),
		logEmbeddingUsageAsync: vi.fn(),
	},
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			projectContext: {
				findMany: (...args: unknown[]) => mocks.findMany(...args),
			},
		},
		getProjectRagSettings: (...args: unknown[]) =>
			mocks.getProjectRagSettings(...args),
		getRetrievableConversationBundleById: (...args: unknown[]) =>
			mocks.getRetrievableConversationBundleById(...args),
	};
});

// No `importOriginal`: the barrel boots the whole provider registry. See
// retrieve-project-contexts-exclusion.test.ts.
vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	embed: (...args: unknown[]) => mocks.embed(...args),
	getAIEmbeddingModelWithMetadata: (...args: unknown[]) =>
		mocks.getAIEmbeddingModelWithMetadata(...args),
	getAIModelWithMetadata: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
	logEmbeddingUsageAsync: (...args: unknown[]) =>
		mocks.logEmbeddingUsageAsync(...args),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/rag", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/rag")>();
	return {
		...actual,
		searchSimilarProjectContexts: (...args: unknown[]) =>
			mocks.searchSimilarProjectContexts(...args),
		applyContextSummary: (...args: unknown[]) =>
			mocks.applyContextSummary(...args),
		rerankContexts: (...args: unknown[]) => mocks.rerankContexts(...args),
	};
});

const { retrieveProjectContexts } = await import(
	"../project-document-generation"
);
const { activityLogger } = await import("../lib/activity-logger");

const PARAMS = {
	projectId: "proj_1",
	userId: "user_1",
	organizationId: "org_1",
	documentType: "PRD",
};

function bundleEnvelope(bundleId: string) {
	return {
		id: bundleId,
		type: "INTEGRATION",
		content: `messages of ${bundleId}`,
		createdAt: new Date("2026-10-01T00:00:00Z"),
		metadata: { provider: "SLACK", conversationBundleId: bundleId },
		originalFilename: null,
		sourceUrl: null,
		sourceTitle: "#launch",
		sourceType: null,
		aiInstructions: null,
	};
}

function requestedContextIds(): string[] {
	const call = mocks.findMany.mock.calls[0]?.[0] as
		| { where: { id: { in: string[] } } }
		| undefined;
	return call?.where.id.in ?? [];
}

const warnSpy = vi.spyOn(activityLogger, "warn");

beforeEach(() => {
	vi.clearAllMocks();

	mocks.getProjectRagSettings.mockResolvedValue({
		topK: 10,
		similarityThreshold: 0.5,
		enableReranking: false,
		rerankTopK: 10,
		rerankerProvider: "cross-encoder",
	});
	mocks.getAIEmbeddingModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-embedding", provider: "test" },
		trackUsage: vi.fn(),
	});
	mocks.embed.mockResolvedValue({
		embedding: [0.1, 0.2, 0.3],
		usage: { tokens: 7 },
	});
	mocks.applyContextSummary.mockImplementation(
		async (contexts: unknown) => contexts,
	);
	mocks.findMany.mockImplementation(
		async ({ where }: { where: { id: { in: string[] } } }) =>
			where.id.in.map((id) => ({
				id,
				content: `content of ${id}`,
				type: "TEXT",
				metadata: null,
				originalFilename: null,
				sourceUrl: null,
				sourceTitle: null,
			})),
	);
	mocks.getRetrievableConversationBundleById.mockImplementation(
		async ({ bundleId }: { bundleId: string }) => bundleEnvelope(bundleId),
	);
});

describe("retrieveProjectContexts conversation bundles", () => {
	it("resolves a bundle hit through the bundle table, in score order", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_a-chunk-0", score: 0.92 },
			{
				contextId: "bundle_1-chunk-0",
				score: 0.88,
				conversationBundleId: "bundle_1",
			},
			{
				contextId: "bundle_1-chunk-3",
				score: 0.8,
				conversationBundleId: "bundle_1",
			},
			{ contextId: "ctx_b", score: 0.7 },
		]);

		const contexts = await retrieveProjectContexts(PARAMS);

		expect(contexts).toEqual([
			"content of ctx_a",
			"messages of bundle_1",
			"content of ctx_b",
		]);
		expect(requestedContextIds()).toEqual(["ctx_a", "ctx_b"]);
		expect(
			mocks.getRetrievableConversationBundleById,
		).toHaveBeenCalledTimes(1);
		expect(mocks.getRetrievableConversationBundleById).toHaveBeenCalledWith(
			{
				bundleId: "bundle_1",
				projectId: "proj_1",
				tenant: { userId: "user_1", organizationId: "org_1" },
			},
		);
		expect(warnSpy).not.toHaveBeenCalledWith(
			"RAG hits with no context row were dropped",
			expect.anything(),
		);
	});

	it("describes a bundle hit as other in the source manifest, and a context row by its id", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_a-chunk-0", score: 0.92 },
			{
				contextId: "bundle_1-chunk-0",
				score: 0.88,
				conversationBundleId: "bundle_1",
			},
		]);

		const result = await retrieveProjectContexts({
			...PARAMS,
			includeSourceManifest: true,
		});

		expect(result.contexts).toEqual([
			"content of ctx_a",
			"messages of bundle_1",
		]);
		expect(
			result.manifest.map((entry) => [entry.kind, entry.id, entry.title]),
		).toEqual([
			["projectContext", "ctx_a", null],
			// A conversation has no context row to link to.
			["other", null, "#launch"],
		]);
	});

	it("skips the context table entirely when every hit is a bundle", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{
				contextId: "bundle_1",
				score: 0.9,
				conversationBundleId: "bundle_1",
			},
		]);

		const contexts = await retrieveProjectContexts(PARAMS);

		expect(contexts).toEqual(["messages of bundle_1"]);
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("counts a bundle that no longer resolves as dropped", async () => {
		mocks.getRetrievableConversationBundleById.mockResolvedValue(null);
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{ contextId: "ctx_a", score: 0.9 },
			{
				contextId: "bundle_gone",
				score: 0.8,
				conversationBundleId: "bundle_gone",
			},
		]);

		const contexts = await retrieveProjectContexts(PARAMS);

		expect(contexts).toEqual(["content of ctx_a"]);
		expect(warnSpy).toHaveBeenCalledWith(
			"RAG hits with no context row were dropped",
			expect.objectContaining({
				hitCount: 2,
				resolvedCount: 1,
				sampleDroppedIds: ["bundle_gone"],
			}),
		);
	});

	it("scopes a personal-context lookup to the user", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{
				contextId: "bundle_1",
				score: 0.9,
				conversationBundleId: "bundle_1",
			},
		]);

		await retrieveProjectContexts({
			...PARAMS,
			organizationId: undefined,
		});

		expect(mocks.getRetrievableConversationBundleById).toHaveBeenCalledWith(
			{
				bundleId: "bundle_1",
				projectId: "proj_1",
				tenant: { userId: "user_1", organizationId: undefined },
			},
		);
	});

	it("still honours the exclusion for a bundle hit", async () => {
		mocks.searchSimilarProjectContexts.mockResolvedValue([
			{
				contextId: "bundle_1",
				score: 0.9,
				conversationBundleId: "bundle_1",
			},
			{ contextId: "ctx_a", score: 0.8 },
		]);

		const contexts = await retrieveProjectContexts({
			...PARAMS,
			excludeContextId: "bundle_1",
		});

		expect(contexts).toEqual(["content of ctx_a"]);
		expect(
			mocks.getRetrievableConversationBundleById,
		).not.toHaveBeenCalled();
	});
});

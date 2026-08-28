/**
 * The bundle marker's round trip through the vector store (Fizzy #2228, U12).
 *
 * A captured conversation bundle is embedded under its own row id, in a table
 * the retrieval refetch does not otherwise look in. The point payload is the
 * only thing that can say "this is a bundle, here is its id" — and it was
 * dropped twice on the way in: `embedProjectContext` forwards a fixed subset of
 * the caller's metadata, and `storeProjectContext` builds an explicit payload
 * from a fixed key list. Either omission alone makes the bundle unresolvable
 * while every capture-side test still passes.
 *
 * The negative assertions matter as much: an ordinary context point must keep
 * writing null here, so existing points and existing delete filters are
 * untouched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	upsertMock,
	searchMock,
	ensureCollectionMock,
	getLayoutMock,
	generateEmbeddingMock,
	getProjectRagSettingsMock,
	markContextAsEmbeddedMock,
	routeContentForChunkingMock,
} = vi.hoisted(() => ({
	upsertMock: vi.fn(),
	searchMock: vi.fn(),
	ensureCollectionMock: vi.fn(),
	getLayoutMock: vi.fn(),
	generateEmbeddingMock: vi.fn(),
	getProjectRagSettingsMock: vi.fn(),
	markContextAsEmbeddedMock: vi.fn(),
	routeContentForChunkingMock: vi.fn(),
}));

vi.mock("../client", () => ({
	qdrantClient: {
		upsert: upsertMock,
		search: searchMock,
		query: searchMock,
	},
}));

vi.mock("../../collection-manager", () => ({
	ensureCollection: ensureCollectionMock,
	getCollectionLayout: getLayoutMock,
}));

vi.mock("../../embedding", () => ({
	generateEmbedding: generateEmbeddingMock,
}));

vi.mock("../../chunking", () => ({
	chunkDescribedOpenApiSpec: vi.fn(),
	chunkText: vi.fn(),
	detectContentType: vi.fn(() => ({ type: "text" })),
	enrichChunksWithTenantContext: vi.fn(),
	routeContentForChunking: routeContentForChunkingMock,
}));

vi.mock("@repo/database", () => ({
	getProjectRagSettings: getProjectRagSettingsMock,
	markContextAsEmbedded: markContextAsEmbeddedMock,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { embedProjectContext } from "../auto-embed";
import { searchSimilarProjectContexts, storeProjectContext } from "../store";

/** The payload the implementation handed Qdrant on its only upsert. */
function upsertedPayload(): Record<string, unknown> {
	return upsertMock.mock.calls[0]?.[1]?.points?.[0]?.payload ?? {};
}

const STORE_BASE = {
	projectId: "proj-1",
	userId: "user-1",
	content: "## Conversation in #delivery\n**Ada**: the migration lands.",
	embedding: [0.1, 0.2, 0.3],
};

beforeEach(() => {
	vi.clearAllMocks();
	ensureCollectionMock.mockResolvedValue("project-contexts");
	getLayoutMock.mockResolvedValue({
		supportsHybrid: false,
		denseVectorName: null,
	});
	upsertMock.mockResolvedValue(undefined);
	searchMock.mockResolvedValue([]);
	generateEmbeddingMock.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
	getProjectRagSettingsMock.mockResolvedValue({
		chunkSize: 512,
		chunkOverlap: 50,
		splitMethod: "PARAGRAPH",
	});
	markContextAsEmbeddedMock.mockResolvedValue(undefined);
	routeContentForChunkingMock.mockResolvedValue({ kind: "text" });
});

describe("storeProjectContext — bundle marker", () => {
	it("writes the bundle id and its channel into the point payload", async () => {
		await storeProjectContext({
			...STORE_BASE,
			contextId: "bundle-1",
			metadata: {
				type: "INTEGRATION",
				conversationBundleId: "bundle-1",
				parentContextId: "ctx-channel",
			},
		});

		expect(upsertedPayload()).toMatchObject({
			contextId: "bundle-1",
			conversationBundleId: "bundle-1",
			parentContextId: "ctx-channel",
		});
	});

	it("writes null for an ordinary context, leaving existing points unchanged", async () => {
		await storeProjectContext({
			...STORE_BASE,
			contextId: "ctx-prd",
			metadata: { type: "FILE", filename: "prd.md" },
		});

		expect(upsertedPayload()).toMatchObject({
			conversationBundleId: null,
			parentContextId: null,
		});
	});
});

describe("searchSimilarProjectContexts — bundle marker", () => {
	it("carries the bundle id back out of the payload", async () => {
		searchMock.mockResolvedValue([
			{
				id: "point-1",
				score: 0.91,
				payload: {
					contextId: "bundle-1",
					originalContextId: "bundle-1",
					projectId: "proj-1",
					type: "INTEGRATION",
					conversationBundleId: "bundle-1",
				},
			},
		]);

		const results = await searchSimilarProjectContexts({
			projectId: "proj-1",
			userId: "user-1",
			queryEmbedding: [0.1, 0.2, 0.3],
		});

		expect(results[0]).toMatchObject({
			contextId: "bundle-1",
			conversationBundleId: "bundle-1",
		});
	});

	it("leaves the marker undefined for a point that predates it", async () => {
		searchMock.mockResolvedValue([
			{
				id: "point-2",
				score: 0.8,
				payload: {
					contextId: "ctx-prd",
					projectId: "proj-1",
					type: "FILE",
				},
			},
		]);

		const results = await searchSimilarProjectContexts({
			projectId: "proj-1",
			userId: "user-1",
			queryEmbedding: [0.1, 0.2, 0.3],
		});

		expect(results[0].conversationBundleId).toBeUndefined();
	});
});

describe("embedProjectContext — bundle marker", () => {
	it("forwards the caller's bundle metadata to the point payload", async () => {
		const result = await embedProjectContext({
			contextId: "bundle-1",
			projectId: "proj-1",
			userId: "user-1",
			content: STORE_BASE.content,
			type: "INTEGRATION",
			apiKey: "test-key",
			metadata: {
				conversationBundleId: "bundle-1",
				parentContextId: "ctx-channel",
				sourceTitle: "#delivery",
			},
			// The bundle owns its row in a sibling table, so the shared
			// post-embed context update must not run.
			skipDbUpdate: true,
		});

		expect(result.success).toBe(true);
		expect(markContextAsEmbeddedMock).not.toHaveBeenCalled();
		expect(upsertedPayload()).toMatchObject({
			contextId: "bundle-1",
			originalContextId: "bundle-1",
			conversationBundleId: "bundle-1",
			parentContextId: "ctx-channel",
			sourceTitle: "#delivery",
		});
	});
});

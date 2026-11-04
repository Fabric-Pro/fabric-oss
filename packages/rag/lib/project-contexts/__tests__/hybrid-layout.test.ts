import type { QdrantClient } from "@qdrant/js-client-rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { qdrantClient } from "../../vector-store/client";

const h = vi.hoisted(() => ({
	layout: {
		collectionName: "project-contexts",
		denseVectorName: null as string | null,
		sparseVectorName: "sparse",
		supportsHybrid: true,
	},
	upsert: vi.fn<QdrantClient["upsert"]>(),
	query: vi.fn<QdrantClient["query"]>(),
	search: vi.fn<(typeof qdrantClient)["search"]>(),
	scroll: vi.fn(),
	getCollection: vi.fn(),
	count: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@repo/database", () => ({
	db: {
		documentChunk: {
			create: vi.fn(async () => ({ id: "example-chunk" })),
			findMany: vi.fn(async () => []),
		},
	},
	getProjectCodeIndexes: vi.fn(async () => [{ status: "READY" }]),
}));
vi.mock("../../collection-manager", () => ({
	ensureCollection: vi.fn(async () => "project-contexts"),
	getCollectionLayout: vi.fn(async () => h.layout),
}));
vi.mock("../../workspace-documents/client", () => ({ qdrantClient: h }));
vi.mock("../client", () => ({ qdrantClient: h }));
vi.mock("../../vector-store/client", () => ({ qdrantClient: h }));
vi.mock("../../embedding", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
}));

import { generateSparseVector } from "../../embedding/sparse";
import { searchSimilarChunks, storeChunk } from "../../vector-store/store";
import {
	searchWizardContexts,
	storeWizardContext,
} from "../../wizard-contexts/store";
import {
	searchWorkspaceChunks,
	storeWorkspaceChunk,
} from "../../workspace-documents/store";
import { searchProjectCodeIndex } from "../code-search";
import { searchSimilarProjectContexts, storeProjectContext } from "../store";

const embedding = [0.1, 0.2];
const content = "keyword example";
beforeEach(() => {
	vi.clearAllMocks();
	h.layout.supportsHybrid = true;
	h.query.mockResolvedValue({ points: [] });
	h.search.mockResolvedValue([]);
	h.scroll.mockResolvedValue({ points: [] });
	h.count.mockResolvedValue({ count: 1 });
	h.getCollection.mockResolvedValue({
		config: { params: { vectors: { size: 2 } } },
	});
});
describe.each([null, "dense"])("dense vector name %s", (name) => {
	beforeEach(() => {
		h.layout.denseVectorName = name;
	});
	it("upserts project and wizard points with both vector spaces", async () => {
		await storeProjectContext({
			contextId: "example-context",
			projectId: "example-project",
			userId: "example-user",
			content,
			embedding,
		});
		await storeWizardContext({
			contextId: "example-context",
			sessionId: "example-session",
			userId: "example-user",
			content,
			embedding,
		});
		for (const [, request] of h.upsert.mock.calls) {
			expect(
				"points" in request ? request.points[0]?.vector : undefined,
			).toEqual({
				[name ?? ""]: embedding,
				sparse: generateSparseVector(content),
			});
		}
		expect(h.upsert).toHaveBeenCalledTimes(2);
	});
	it("queries project content and code with dense and sparse prefetch", async () => {
		await searchSimilarProjectContexts({
			projectId: "example-project",
			userId: "example-user",
			queryEmbedding: embedding,
			querySparseVector: generateSparseVector(content),
		});
		await searchProjectCodeIndex({
			projectId: "example-project",
			userId: "example-user",
			query: content,
		});
		expect(h.query).toHaveBeenCalledTimes(2);
		for (const [, request] of h.query.mock.calls) {
			expect(request.prefetch).toEqual([
				expect.objectContaining({
					query: embedding,
					...(name ? { using: name } : {}),
				}),
				expect.objectContaining({
					using: "sparse",
					query: generateSparseVector(content),
				}),
			]);
			const dense = (request.prefetch as Array<{ using?: string }>)[0];
			expect(dense?.using).toBe(name ?? undefined);
			expect(request.query).toEqual({ fusion: "rrf" });
		}
	});
	it("selects the wizard dense vector explicitly when named", async () => {
		await searchWizardContexts({
			sessionId: "example-session",
			userId: "example-user",
			queryEmbedding: embedding,
		});
		expect(h.search).toHaveBeenCalledWith(
			"project-contexts",
			expect.objectContaining({
				vector: name ? { name, vector: embedding } : embedding,
			}),
		);
	});
	it("keeps chat and workspace sibling writes and searches layout-aware", async () => {
		const common = {
			documentId: "example-document",
			userId: "example-user",
			organizationId: "example-org",
			content,
			embedding,
			chunkIndex: 0,
			metadata: {},
		};
		await storeChunk({ ...common, chatId: "example-chat" });
		await storeWorkspaceChunk({
			...common,
			chunkId: "example-chunk",
			workspaceId: "example-workspace",
		});
		for (const [, request] of h.upsert.mock.calls) {
			expect("points" in request && request.points[0]?.vector).toEqual({
				[name ?? ""]: embedding,
				sparse: generateSparseVector(content),
			});
		}
		await searchSimilarChunks({
			chatId: "example-chat",
			userId: "example-user",
			organizationId: "example-org",
			queryEmbedding: embedding,
			querySparseVector: generateSparseVector(content),
		});
		await searchWorkspaceChunks({
			workspaceId: "example-workspace",
			userId: "example-user",
			organizationId: "example-org",
			queryEmbedding: embedding,
			querySparseVector: generateSparseVector(content),
		});
		expect(h.query).toHaveBeenCalledTimes(2);
		for (const [, request] of h.query.mock.calls) {
			expect(
				(request.prefetch as Array<{ using?: string }>)[0]?.using,
			).toBe(name ?? undefined);
		}
		for (const [, request] of h.search.mock.calls) {
			expect(request.vector).toEqual(
				name ? { name, vector: embedding } : embedding,
			);
		}
	});
	it("keeps old-server writes dense-only", async () => {
		h.layout.supportsHybrid = false;
		h.layout.denseVectorName = null;
		await storeWizardContext({
			contextId: "example-context",
			sessionId: "example-session",
			userId: "example-user",
			content,
			embedding,
		});
		const request = h.upsert.mock.calls[0]?.[1];
		if (!request || !("points" in request)) {
			throw new Error("expected a point upsert");
		}
		expect(request.points[0]?.vector).toEqual(embedding);
	});
});

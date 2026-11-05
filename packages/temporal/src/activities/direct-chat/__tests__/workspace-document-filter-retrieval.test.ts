import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	authorize: vi.fn(),
	count: vi.fn(),
	chunks: vi.fn(),
	search: vi.fn(),
	embedding: vi.fn(),
}));
vi.mock("@repo/ai", () => ({ getRAGProviderConfig: async () => ({}) }));
vi.mock("@repo/database", () => ({
	db: {
		workspaceDocument: { count: m.count },
		workspaceDocumentChunk: { findMany: m.chunks },
	},
	filterWorkspaceIdsForTenant: async (x: { workspaceIds: string[] }) => ({
		allowed: x.workspaceIds,
		dropped: [],
	}),
	getDefaultRagSettings: () => ({ topK: 5, similarityThreshold: 0.3 }),
	getEffectiveRagSettings: async () => ({
		topK: 5,
		similarityThreshold: 0.3,
	}),
}));
vi.mock("@repo/database/prisma/queries/workspaces/document-content", () => ({
	authorizeWorkspaceDocumentRead: m.authorize,
}));
vi.mock("@repo/rag", () => ({
	generateEmbedding: m.embedding,
	generateSparseVector: () => ({ indices: [], values: [] }),
}));
vi.mock("@repo/rag/lib/workspace-documents/store", () => ({
	searchMultipleWorkspaces: m.search,
}));

import { retrieveWorkspaceDocumentsActivity } from "../rag-retrieval";

const filter = [
	{ workspaceId: "example-a", documentIds: ["example-selected"] },
];
const read = () =>
	retrieveWorkspaceDocumentsActivity(
		"Example question",
		"example-user",
		"example-org",
		["example-a", "example-b"],
		undefined,
		5,
		0.3,
		{ workspaceDocumentFilters: filter },
	);
beforeEach(() => {
	vi.resetAllMocks();
	m.authorize.mockResolvedValue(undefined);
	m.count.mockResolvedValue(1);
	m.search.mockResolvedValue([]);
	m.embedding.mockResolvedValue({ embedding: [0.1] });
	m.chunks.mockResolvedValue([]);
});
describe("native saved document filters in central workspace retrieval", () => {
	it("uses separate bounded filters for a selected document and a whole workspace", async () => {
		await read();
		expect(m.search).toHaveBeenCalledTimes(2);
		expect(m.search).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceIds: ["example-a"],
				documentIds: ["example-selected"],
			}),
		);
		expect(m.search).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceIds: ["example-b"],
				documentIds: undefined,
			}),
		);
		expect(m.embedding).toHaveBeenCalledTimes(1);
	});
	it("checks current workspace/document access before search and before returning content", async () => {
		await read();
		expect(m.authorize).toHaveBeenCalledWith({
			workspaceId: "example-a",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(m.authorize).toHaveBeenCalledWith({
			workspaceId: "example-b",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(m.count).toHaveBeenCalledTimes(2);
	});
	it("never reaches embedding or vector search after initial permission loss", async () => {
		m.authorize.mockRejectedValue(new Error("Access revoked"));
		await expect(read()).rejects.toThrow();
		expect(m.embedding).not.toHaveBeenCalled();
		expect(m.search).not.toHaveBeenCalled();
	});
	it("withholds retrieved material after source deletion during search", async () => {
		m.search.mockImplementation(async () => {
			m.count.mockResolvedValue(0);
			return [];
		});
		await expect(read()).rejects.toThrow();
	});
});

it("scopes physical chunk reads to current organization, workspace and saved selected documents", async () => {
	m.search.mockResolvedValue([
		{
			workspaceId: "example-a",
			documentId: "example-selected",
			chunkId: "example-selected-0",
			chunkIndex: 0,
			score: 0.9,
		},
	]);
	await read();
	expect(m.chunks).toHaveBeenCalledWith(
		expect.objectContaining({
			where: expect.objectContaining({
				document: {
					workspace: { organizationId: "example-org" },
					OR: [
						{
							workspaceId: { in: ["example-a"] },
							id: { in: ["example-selected"] },
						},
						{ workspaceId: { in: ["example-b"] } },
					],
				},
			}),
		}),
	);
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectSearch } from "../project-search";

const mocks = vi.hoisted(() => ({
	retrieveProjectContexts: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	getConnectorBackedDocumentsForWorkspaces: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../embedding", () => ({
	get generateQueryEmbedding() {
		return (this as { generateEmbedding: unknown }).generateEmbedding;
	},
	generateEmbedding: vi.fn(),
	generateSparseVector: vi.fn(),
}));
vi.mock("../../workspace-documents", () => ({
	searchMultipleWorkspaces: vi.fn(),
}));
vi.mock("../../project-contexts", () => ({
	contextMetaHeader: () => "",
	retrieveProjectContexts: mocks.retrieveProjectContexts,
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("projectSearch project-context results", () => {
	it("names a synced file by its full repository path", async () => {
		mocks.retrieveProjectContexts.mockResolvedValue([
			{
				id: "c-1",
				type: "TEXT",
				content: "The QA marker for this file is KESTREL-5530.",
				score: 0.9,
				sourceTitle: "architecture.md",
				sourcePath: "docs/architecture.md",
			},
		]);

		const res = await projectSearch({
			projectId: "p-1",
			query: "KESTREL",
			userId: "u-1",
			sources: ["project-context"],
		});

		expect(res.results[0].source.name).toBe("docs/architecture.md");
	});
});

describe("workspace and connector usage siblings", () => {
	it.each(["conversation-example", undefined])(
		"attributes both embedding branches only from the explicit conversation (%s)",
		async (conversationId) => {
			const { getConnectorBackedDocumentsForWorkspaces } = await import(
				"@repo/database"
			);
			const { generateEmbedding } = await import("../../embedding");
			const { searchMultipleWorkspaces } = await import(
				"../../workspace-documents"
			);
			vi.mocked(
				getConnectorBackedDocumentsForWorkspaces,
			).mockResolvedValue([
				{
					documentId: "doc-example",
					workspaceId: "workspace-example",
					title: "document",
					externalPath: null,
					lastSyncedAt: null,
					connection: {
						id: "connection-example",
						name: "Example",
						provider: "NOTION",
						externalWorkspaceName: null,
					},
				},
			] as never);
			vi.mocked(generateEmbedding).mockResolvedValue({
				embedding: [0.1],
				model: "model-example",
				tokens: 1,
			});
			vi.mocked(searchMultipleWorkspaces).mockResolvedValue([]);
			await projectSearch({
				projectId: "project-example",
				userId: "user-example",
				query: "query",
				workspaceIds: ["workspace-example"],
				sources: ["workspace", "connector"],
				conversationId,
			});
			expect(generateEmbedding).toHaveBeenCalledTimes(2);
			for (const call of vi.mocked(generateEmbedding).mock.calls) {
				expect(call[1]?.conversationId).toBe(conversationId);
			}
		},
	);
});

it("requests matched text and preserves passage scores through cross-source ranking", async () => {
	const matchedPassages = [
		{ content: "Relevant match", score: 0.7 },
		{ content: "Second match", score: 0.5 },
	];
	mocks.retrieveProjectContexts.mockResolvedValue([
		{
			id: "example-context",
			type: "TEXT",
			content: "Whole body",
			score: 0.8,
			matchedPassages,
		},
	]);
	const res = await projectSearch({
		projectId: "example-project",
		query: "match",
		userId: "example-user",
		sources: ["project-context", "web"],
		webSearchFn: async () => [
			{
				id: "example-web",
				content: "Snippet",
				source: { type: "web", name: "Web", badge: "Web" },
				relevance: 1,
			},
		],
		sourceWeights: { web: 1, "project-context": 0.5 },
		totalLimit: 2,
	});
	expect(mocks.retrieveProjectContexts).toHaveBeenCalledWith(
		expect.objectContaining({ includeMatchedPassages: true }),
	);
	expect(res.results.map((r) => r.id)).toEqual([
		"example-web",
		"example-context",
	]);
	expect(res.results[1].matchedPassages).toBe(matchedPassages);
});

it("carries summary identity so the formatter can reserve its reference legend", async () => {
	mocks.retrieveProjectContexts.mockResolvedValue([
		{
			id: "example-summary",
			type: "PROJECT_SUMMARY",
			content:
				"Summary [S1]\n---\nSOURCE REFERENCES\n[S1] = example-source",
			score: 1,
		},
	]);
	const res = await projectSearch({
		projectId: "example-project",
		userId: "example-user",
		query: "summary",
		sources: ["project-context"],
	});
	expect(res.results[0].metadata?.isSummary).toBe(true);
	expect(res.results[0].content).toContain("SOURCE REFERENCES");
});

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

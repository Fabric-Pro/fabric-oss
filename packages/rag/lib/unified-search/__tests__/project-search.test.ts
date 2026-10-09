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

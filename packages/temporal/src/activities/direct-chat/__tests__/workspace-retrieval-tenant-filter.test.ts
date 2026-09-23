/**
 * `retrieveWorkspaceDocumentsActivity` narrows its workspace ids to the call's
 * tenant before it reads anything for them.
 *
 * Every workspace search the workers run funnels through this activity, and
 * some callers hand it ids read back from rows saved long before the run: an
 * agent instance's stored `workspaceIds` could name another organization's
 * workspace until instance writes started refusing it. The rule itself is
 * unit-tested with `filterWorkspaceIdsForTenant` in `@repo/database`; these
 * tests pin the activity to it, so a foreign id never reaches the settings
 * lookup, the embedding call or the Qdrant search.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	filterWorkspaceIdsForTenant: vi.fn(),
	getEffectiveRagSettings: vi.fn(),
	searchMultipleWorkspaces: vi.fn(),
	generateEmbedding: vi.fn(),
}));

// Full mocks, no `importOriginal`: the activity reads only these names, and
// loading the real barrels would boot the Prisma pool and the provider registry
// for a test that needs neither.
vi.mock("@repo/database", () => ({
	db: { workspaceDocumentChunk: { findMany: vi.fn() } },
	filterWorkspaceIdsForTenant: (...args: unknown[]) =>
		mocks.filterWorkspaceIdsForTenant(...args),
	getDefaultRagSettings: () => ({ topK: 5, similarityThreshold: 0.3 }),
	getEffectiveRagSettings: (...args: unknown[]) =>
		mocks.getEffectiveRagSettings(...args),
}));

vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("@repo/rag/lib/workspace-documents/store", () => ({
	searchMultipleWorkspaces: (...args: unknown[]) =>
		mocks.searchMultipleWorkspaces(...args),
}));

vi.mock("@repo/rag", () => ({
	generateEmbedding: (...args: unknown[]) => mocks.generateEmbedding(...args),
	generateSparseVector: () => ({ indices: [], values: [] }),
}));

import { retrieveWorkspaceDocumentsActivity } from "../rag-retrieval";

// Which organization hosts each workspace in these tests.
const HOSTING_ORGANIZATION: Record<string, string | null> = {
	"ws-a": "example-org-a",
	"ws-b": "example-org-b",
};

describe("retrieveWorkspaceDocumentsActivity tenant filter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.filterWorkspaceIdsForTenant.mockImplementation(
			async (params: {
				workspaceIds: string[];
				organizationId: string | null | undefined;
			}) => {
				const tenant = params.organizationId ?? null;
				return {
					allowed: params.workspaceIds.filter(
						(id) => HOSTING_ORGANIZATION[id] === tenant,
					),
					dropped: params.workspaceIds.filter(
						(id) => HOSTING_ORGANIZATION[id] !== tenant,
					),
				};
			},
		);
		mocks.getEffectiveRagSettings.mockResolvedValue({
			topK: 5,
			similarityThreshold: 0.3,
		});
		mocks.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
		mocks.searchMultipleWorkspaces.mockResolvedValue([]);
	});

	it("searches only the workspaces hosted by the caller's organization", async () => {
		await retrieveWorkspaceDocumentsActivity(
			"what changed?",
			"user-1",
			"example-org-a",
			["ws-a", "ws-b"],
		);

		expect(mocks.filterWorkspaceIdsForTenant).toHaveBeenCalledWith({
			workspaceIds: ["ws-a", "ws-b"],
			userId: "user-1",
			organizationId: "example-org-a",
		});
		expect(mocks.searchMultipleWorkspaces).toHaveBeenCalledTimes(1);
		expect(mocks.searchMultipleWorkspaces).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceIds: ["ws-a"],
				organizationId: "example-org-a",
			}),
		);
		expect(mocks.getEffectiveRagSettings).toHaveBeenCalledTimes(1);
		expect(mocks.getEffectiveRagSettings).toHaveBeenCalledWith("ws-a");
	});

	it("returns the empty result without searching when every id is foreign", async () => {
		const result = await retrieveWorkspaceDocumentsActivity(
			"what changed?",
			"user-1",
			"example-org-a",
			["ws-b"],
		);

		expect(result).toEqual({ context: "", chunkCount: 0 });
		expect(mocks.searchMultipleWorkspaces).not.toHaveBeenCalled();
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
		expect(mocks.getEffectiveRagSettings).not.toHaveBeenCalled();
	});
});

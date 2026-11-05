/**
 * The workspace reads are offered only when a workspace is attached
 * (Fizzy #3215). Without one every call failed and spent a turn step.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({ tool: (definition: unknown) => definition }));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("../../lib/get-search-provider", () => ({
	resolveSearchProviderForTenant: async () => null,
}));
vi.mock("../rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));

import { createBuiltInTools } from "../built-in-tools";
import { retrieveWorkspaceDocumentsActivity } from "../rag-retrieval";

const WORKSPACE_TOOL_IDS = ["workspace_rag_query", "workspace_rag_summarize"];
const base = { userId: "user-example", organizationId: "org-example" };

describe("workspace tools without an attached workspace", () => {
	it.each([{ workspaceIds: undefined }, { workspaceIds: [] }])(
		"are not bound from an explicit tool list (workspaceIds: $workspaceIds)",
		async ({ workspaceIds }) => {
			const tools = await createBuiltInTools({
				...base,
				workspaceIds,
				enabledFabricToolIds: [
					...WORKSPACE_TOOL_IDS,
					"fabric_scrape_url",
				],
			});
			expect(Object.keys(tools)).toEqual(["fabric_scrape_url"]);
		},
	);

	it.each([{ workspaceIds: undefined }, { workspaceIds: [] }])(
		"are not bound as additional tools (workspaceIds: $workspaceIds)",
		async ({ workspaceIds }) => {
			const tools = await createBuiltInTools({
				...base,
				workspaceIds,
				additionalFabricToolIds: WORKSPACE_TOOL_IDS,
			});
			for (const id of WORKSPACE_TOOL_IDS) {
				expect(tools).not.toHaveProperty(id);
			}
		},
	);

	it("are bound once a workspace is attached", async () => {
		const tools = await createBuiltInTools({
			...base,
			workspaceIds: ["workspace-example"],
			enabledFabricToolIds: WORKSPACE_TOOL_IDS,
		});
		expect(Object.keys(tools).sort()).toEqual(WORKSPACE_TOOL_IDS);
	});
});

describe("selected document filters in loaded workspace tools", () => {
	it.each(WORKSPACE_TOOL_IDS)(
		"binds %s to saved source selections, never model-provided replacements",
		async (id) => {
			vi.mocked(retrieveWorkspaceDocumentsActivity).mockResolvedValue({
				context: "Example answer",
				chunkCount: 1,
			});
			const workspaceDocumentFilters = [
				{
					workspaceId: "workspace-example",
					documentIds: ["document-example"],
				},
			];
			const tools = await createBuiltInTools({
				...base,
				workspaceIds: ["workspace-example"],
				workspaceDocumentFilters,
				enabledFabricToolIds: [id],
			});
			const selected = tools[id] as {
				execute: (args: Record<string, unknown>) => Promise<unknown>;
			};
			await selected.execute({
				query: "Example question",
				workspaceIds: ["workspace-foreign"],
				workspaceDocumentFilters: [],
			});
			expect(retrieveWorkspaceDocumentsActivity).toHaveBeenLastCalledWith(
				"Example question",
				base.userId,
				base.organizationId,
				["workspace-example"],
				undefined,
				id === "workspace_rag_summarize" ? 20 : undefined,
				undefined,
				expect.objectContaining({ workspaceDocumentFilters }),
			);
		},
	);
});

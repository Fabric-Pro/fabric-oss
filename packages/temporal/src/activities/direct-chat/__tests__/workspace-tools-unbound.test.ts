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

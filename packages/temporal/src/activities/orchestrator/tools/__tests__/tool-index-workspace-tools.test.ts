import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		mCPConfig: {
			// The mock reports no disabled MCP config rows.
			findMany: async () => [],
		},
	},
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
	generateEmbeddings: vi.fn(async () => ({ embeddings: [] })),
}));

const store = vi.hoisted(() => ({
	searchCapabilities: vi.fn(),
	getCapabilitiesByTenant: vi.fn(),
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	isCapabilityStoreAvailable: vi.fn(async () => true),
	searchCapabilities: store.searchCapabilities,
	getCapabilitiesByTenant: store.getCapabilitiesByTenant,
	upsertCapabilities: vi.fn(),
	deleteCapabilitiesByServer: vi.fn(),
}));

import { ToolIndex } from "../tool-index";
import { WORKSPACE_TOOL_NAMES } from "../workspace-tools";

/** An indexed tool as the capability store returns it. */
function indexed(configId: string, name: string, serverName: string) {
	return {
		score: 0.9,
		capability: {
			id: `user-example:${serverName}:${name}`,
			name,
			description: `${name} on ${serverName}`,
			metadata: {
				configId,
				serverName,
				category: "development",
				isReadOnly: true,
			},
		},
	};
}

const WORKSPACE_NAMES = Object.values(WORKSPACE_TOOL_NAMES);
const ALL = WORKSPACE_NAMES.map((name) =>
	indexed("fabric-ai-server", name, "Fabric AI"),
);

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	store.searchCapabilities.mockResolvedValue(ALL);
	store.getCapabilitiesByTenant.mockResolvedValue(ALL);
});

describe.each(["in-memory", "Qdrant"])("%s workspace tools", (read) => {
	it.each([[null], [[]]])(
		"gates per request with Fabric list %j",
		async (enabledFabricToolIds) => {
			const index = new ToolIndex();
			expect(
				await index.loadFromQdrant("user-example", "org-example"),
			).toBe(true);
			for (const workspaceIds of [undefined, [], ["ws-example"]]) {
				const results = await index.search({
					query: "workspace",
					minConfidence: 0,
					...(read === "Qdrant"
						? {
								userId: "user-example",
								organizationId: "org-example",
							}
						: {}),
					enabledFabricToolIds,
					workspaceIds,
				});
				expect(results.map((r) => r.tool.toolName).sort()).toEqual(
					workspaceIds?.length === 0 ? [] : WORKSPACE_NAMES,
				);
				expect(index.getAllEntries()).toHaveLength(2);
			}
		},
	);
});

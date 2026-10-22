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

import { PROJECT_TOOL_NAMES } from "../project-tools";
import { ToolIndex } from "../tool-index";

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

const PROJECT_NAMES = PROJECT_TOOL_NAMES;
const ALL = PROJECT_NAMES.map((name) =>
	indexed("fabric-ai-server", name, "Fabric AI"),
);

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	store.searchCapabilities.mockResolvedValue(ALL);
	store.getCapabilitiesByTenant.mockResolvedValue(ALL);
});

describe.each(["in-memory", "Qdrant"])("%s project tools", (read) => {
	it.each([[null], [[]], [[...PROJECT_NAMES]]])(
		"gates per request with Fabric list %j",
		async (enabledFabricToolIds) => {
			const index = new ToolIndex();
			expect(
				await index.loadFromQdrant("user-example", "org-example"),
			).toBe(true);
			let baseline: string[] = [];
			for (const projectId of [undefined, null, "project-example"]) {
				const results = await index.search({
					query: "project",
					minConfidence: 0,
					limit: 100,
					...(read === "Qdrant"
						? {
								userId: "user-example",
								organizationId: "org-example",
							}
						: {}),
					enabledFabricToolIds,
					projectId,
				});
				const names = results.map((r) => r.tool.toolName).sort();
				if (projectId === undefined) {
					baseline = names;
					expect(baseline.length).toBeGreaterThan(0);
				}
				expect(names).toEqual(projectId === null ? [] : baseline);

				expect(index.getAllEntries()).toHaveLength(
					PROJECT_NAMES.length,
				);
			}
		},
	);
});

describe.each(["in-memory", "Qdrant"])("%s server context", (read) => {
	it.each(["cfg-example", "oauth:integration:example"])(
		"keeps external project tool names on %s",
		async (configId) => {
			const names = [
				"code_search",
				"code_tree",
				"weave_query",
				"project_rag_query",
			];
			const entries = names.flatMap((name) => [
				indexed("fabric-ai-server", name, "Fabric AI"),
				indexed(configId, name, "Example Service"),
			]);
			store.searchCapabilities.mockResolvedValue(entries);
			store.getCapabilitiesByTenant.mockResolvedValue(entries);
			const index = new ToolIndex();
			await index.loadFromQdrant("user-example", "org-example");
			const results = await index.search({
				query: "code tree project rag weave",
				minConfidence: 0,
				limit: 100,
				projectId: null,
				...(read === "Qdrant"
					? { userId: "user-example", organizationId: "org-example" }
					: {}),
			});
			expect(
				results.map((r) => [r.tool.configId, r.tool.toolName]).sort(),
			).toEqual(
				["code_search", "code_tree", "weave_query"]
					.map((name) => [configId, name])
					.sort(),
			);
		},
	);

	it("hides project tool names stored without a server id", async () => {
		const entries = [indexed("", "code_tree", "Fabric AI")];
		store.searchCapabilities.mockResolvedValue(entries);
		store.getCapabilitiesByTenant.mockResolvedValue(entries);
		const index = new ToolIndex();
		await index.loadFromQdrant("user-example", "org-example");
		for (const projectId of [undefined, null]) {
			const results = await index.search({
				query: "code tree",
				minConfidence: 0,
				limit: 100,
				projectId,
				...(read === "Qdrant"
					? { userId: "user-example", organizationId: "org-example" }
					: {}),
			});
			expect(results.map((r) => r.tool.toolName)).toEqual(
				projectId === null ? [] : ["code_tree"],
			);
		}
	});
});

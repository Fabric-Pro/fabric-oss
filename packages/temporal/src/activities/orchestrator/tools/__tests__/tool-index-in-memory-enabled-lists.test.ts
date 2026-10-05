/**
 * The in-memory index is shared between requests: it is rebuilt when it
 * expires or the tenant changes, not when a request's enabled lists change,
 * so it can hold tools an earlier request's lists allowed. Its search (the
 * keyword shortcut of `search_tools`, and the fallback when Qdrant search
 * fails) must apply this request's MCP config, integration and Fabric tool
 * lists the way the Qdrant reads do, before ranking and limiting (Fizzy
 * #2925).
 *
 * The capability store is a stand-in, and `db.mCPConfig.findMany` is a stub
 * that reports no config as turned off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configRows = vi.hoisted(() => ({
	// Every config row is turned on; none is reported as disabled.
	findMany: vi.fn(async () => [] as Array<{ id: string }>),
}));
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: { mCPConfig: configRows },
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
	generateEmbeddings: vi.fn(async () => ({ embeddings: [] })),
}));

const store = vi.hoisted(() => ({
	getCapabilitiesByTenant: vi.fn(),
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	isCapabilityStoreAvailable: vi.fn(async () => true),
	searchCapabilities: vi.fn(),
	getCapabilitiesByTenant: store.getCapabilitiesByTenant,
	upsertCapabilities: vi.fn(),
	deleteCapabilitiesByServer: vi.fn(),
}));

import {
	ToolIndex,
	type ToolIndexEntry,
	type ToolSearchOptions,
} from "../tool-index";

/** An indexed tool as the capability store returns it. */
function indexed(
	configId: string,
	name: string,
	serverName: string,
	description = `${name} on ${serverName}`,
) {
	return {
		score: 0.9,
		capability: {
			id: `user-1:${serverName}:${name}`,
			name,
			description,
			metadata: {
				configId,
				serverName,
				category: "development",
				isReadOnly: true,
			},
		},
	};
}

const CODE_TREE = indexed("fabric-ai-server", "code_tree", "Fabric AI");
// In INFRASTRUCTURE_FABRIC_TOOLS: kept whatever the Fabric list says.
const GET_PROJECT_DOCUMENT = indexed(
	"fabric-ai-server",
	"fabric_get_project_document",
	"Fabric AI",
);
const GITHUB = indexed("cfg-github", "list_pull_requests", "GitHub");
const LINEAR = indexed("cfg-linear", "list_linear_issues", "Linear");
const SLACK = indexed("oauth:integration:int-slack", "send_message", "Slack");

/** An index loaded with no list restricting it, as an earlier request left it. */
async function unrestrictedIndex(
	tools: Array<ReturnType<typeof indexed>>,
): Promise<ToolIndex> {
	store.getCapabilitiesByTenant.mockResolvedValue(tools);
	const index = new ToolIndex();
	expect(await index.loadFromQdrant("user-1", "example-org")).toBe(true);
	expect(index.getAllEntries()).toHaveLength(tools.length);
	return index;
}

/** The tools an in-memory search (no `userId`) offers under these lists. */
async function inMemoryNames(
	lists: Pick<
		ToolSearchOptions,
		"enabledMcpConfigIds" | "enabledIntegrationIds" | "enabledFabricToolIds"
	>,
): Promise<string[]> {
	const index = await unrestrictedIndex([
		CODE_TREE,
		GET_PROJECT_DOCUMENT,
		GITHUB,
		LINEAR,
		SLACK,
	]);
	const results = await index.search({
		query: "tools",
		minConfidence: 0,
		...lists,
	});
	return results.map((result) => result.tool.toolName).sort();
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	store.getCapabilitiesByTenant.mockReset();
	configRows.findMany.mockClear();
});

describe("in-memory search applies the request's enabled lists", () => {
	it("offers every tool when no list restricts", async () => {
		expect(await inMemoryNames({})).toEqual(
			[
				"code_tree",
				"fabric_get_project_document",
				"list_linear_issues",
				"list_pull_requests",
				"send_message",
			].sort(),
		);
	});

	it("an empty Fabric list leaves out Fabric AI tools but the infrastructure ones", async () => {
		const names = await inMemoryNames({ enabledFabricToolIds: [] });
		expect(names).not.toContain("code_tree");
		expect(names).toContain("fabric_get_project_document");
		expect(names).toContain("list_pull_requests");
	});

	it("an MCP config list leaves out the servers it does not name, not Fabric AI tools", async () => {
		const names = await inMemoryNames({
			enabledMcpConfigIds: ["cfg-linear"],
		});
		expect(names).not.toContain("list_pull_requests");
		expect(names).toContain("list_linear_issues");
		expect(names).toContain("code_tree");
	});

	it.each([
		["an empty integration list", []],
		["an integration list naming another integration", ["int-other"]],
	])("%s leaves out the OAuth integration's tools", async (_name, ids) => {
		const names = await inMemoryNames({ enabledIntegrationIds: ids });
		expect(names).not.toContain("send_message");
		expect(names).toContain("list_pull_requests");
	});

	it("tools the lists leave out cannot crowd an allowed match out of the limit", async () => {
		// Ten GitHub tools that match the query better than code_tree does.
		const github = Array.from({ length: 10 }, (_, i) =>
			indexed(
				"cfg-github",
				`github_tool_${i}`,
				"GitHub",
				"repository tree repository tree repository tree",
			),
		);
		const codeTree = indexed(
			"fabric-ai-server",
			"code_tree",
			"Fabric AI",
			"List the repository tree of a project repository",
		);
		// Unrelated tools, so the query's terms are rare enough to score.
		const unrelated = Array.from({ length: 30 }, (_, i) =>
			indexed(
				"cfg-weather",
				`forecast_${i}`,
				"Weather",
				"daily forecast",
			),
		);
		const index = await unrestrictedIndex([
			...github,
			codeTree,
			...unrelated,
		]);

		const results = await index.search({
			query: "repository tree",
			limit: 1,
			minConfidence: 0.1,
			enabledMcpConfigIds: [],
		});

		expect(results.map((result) => result.tool.toolName)).toEqual([
			"code_tree",
		]);
	});

	it("leaves out an MCP config's tool added to the index while turned-off configs were looked up", async () => {
		const index = await unrestrictedIndex([LINEAR]);
		const added = (configId: string, toolName: string): ToolIndexEntry => ({
			id: `user-1:Other:${toolName}`,
			serverName: "Other",
			toolName,
			description: toolName,
			keywords: [toolName],
			riskLevel: "low",
			isReadOnly: true,
			lastUpdated: new Date(),
			configId,
		});
		// Another request reloads the shared index during the lookup, so
		// the lookup never saw cfg-new and cannot say whether it is off.
		configRows.findMany.mockImplementationOnce(async () => {
			const writable = index as unknown as {
				addEntry(entry: ToolIndexEntry): void;
			};
			writable.addEntry(added("cfg-new", "new_mcp_tool"));
			writable.addEntry(added("", "new_system_tool"));
			writable.addEntry(added("fabric-ai-server", "new_fabric_tool"));
			writable.addEntry(
				added("oauth:integration:int-new", "new_oauth_tool"),
			);
			return [];
		});

		const results = await index.search({
			query: "tools",
			minConfidence: 0,
		});

		expect(results.map((result) => result.tool.toolName).sort()).toEqual(
			[
				"list_linear_issues",
				"new_fabric_tool",
				"new_oauth_tool",
				"new_system_tool",
			].sort(),
		);
	});
});
